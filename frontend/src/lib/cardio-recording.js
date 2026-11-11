// GPS Cardio Activity Recording Lifecycle (Issue #53)
//
// Manages the complete lifecycle of a GPS recording session:
// - Start watcher via CardioAdapter
// - Stream live stats on GPS fixes (distance, moving time, pace, speed, elevation gain, calories)
// - Pause & resume with segment-aware distance/time filtering
// - Recovery log streaming to survive app reloads/crashes
// - Finish activity: compact track points (RDP), calculate splits, persist <year>/<id>.json track file
// - Discard activity: stop watcher, cleanup recovery log

import {
  getCardioAdapter,
  createMemoryCardioAdapter,
  normalizeFix,
  normalizeTrackPath,
  appendRecoveryLog,
  readRecoveryLog,
  clearRecoveryLog,
  startWatcher,
  stopWatcher,
  writeTrack,
} from './cardio-adapter.js'

import {
  haversineDistance,
  isValidCoordinate,
  isValidPoint,
  getPointLat,
  getPointLon,
  getPointEle,
  getPointTime,
  computeMovingTime,
  computeElapsedTime,
  totalDistance,
  speedToPace,
  computeElevationGain,
  estimateCalories,
  computeSplits,
  ramerDouglasPeucker,
  DEFAULT_MOVING_SPEED_THRESHOLD,
  DEFAULT_RDP_EPSILON,
  DEFAULT_ELEVATION_WINDOW,
  DEFAULT_ELEVATION_THRESHOLD,
} from './track-math.js'

import { uid } from './format.js'

/**
 * Recording session lifecycle states.
 */
export const RECORDING_STATUS = {
  IDLE: 'idle',
  RECORDING: 'recording',
  PAUSED: 'paused',
  FINISHED: 'finished',
  DISCARDED: 'discarded',
}

/**
 * Default live metrics structure.
 */
export const DEFAULT_LIVE_STATS = Object.freeze({
  distanceM: 0,
  movingTimeMs: 0,
  elapsedTimeMs: 0,
  currentPace: 0,
  avgPace: 0,
  currentSpeed: 0,
  avgSpeed: 0,
  elevationGainM: 0,
  calories: 0,
})

/**
 * Compacts track points using Ramer-Douglas-Peucker algorithm.
 *
 * @param {Array<Object>} points - Array of GPS points
 * @param {number} [epsilon=DEFAULT_RDP_EPSILON] - Max perpendicular distance tolerance in meters
 * @returns {Array<Object>} Compacted track points
 */
export function compactTrackPoints(points, epsilon = DEFAULT_RDP_EPSILON) {
  if (!Array.isArray(points) || points.length <= 2) return Array.isArray(points) ? points.slice() : []
  return ramerDouglasPeucker(points, epsilon)
}

/**
 * Computes live metrics across recording segments (ignoring pause intervals).
 *
 * @param {Array<Array<Object>>} segments - Array of active segment point arrays
 * @param {Object} [options={}] - Options (activity, unit, weightKg, movingThreshold, startedAtMs)
 * @returns {Object} Live metrics
 */
export function calculateLiveStats(segments, options = {}) {
  const {
    activity = 'run',
    unit = 'kg',
    weightKg = 70,
    movingThreshold = DEFAULT_MOVING_SPEED_THRESHOLD,
    maxGapSeconds = 300,
    startedAtMs = null,
  } = options

  if (!Array.isArray(segments) || segments.length === 0) {
    return { ...DEFAULT_LIVE_STATS }
  }

  const allPoints = segments.flat().filter(isValidPoint)
  if (allPoints.length === 0) {
    return { ...DEFAULT_LIVE_STATS }
  }

  let distanceM = 0
  let movingTimeMs = 0

  for (const seg of segments) {
    if (!Array.isArray(seg)) continue
    const validSeg = seg.filter(isValidPoint)
    for (let i = 1; i < validSeg.length; i++) {
      const p1 = validSeg[i - 1]
      const p2 = validSeg[i]
      const d = haversineDistance(p1, p2)
      distanceM += d

      const t1 = getPointTime(p1)
      const t2 = getPointTime(p2)
      if (t1 != null && t2 != null) {
        const dt = t2 - t1
        if (dt > 0 && dt <= maxGapSeconds * 1000) {
          const spd = d / (dt / 1000)
          if (spd >= movingThreshold) {
            movingTimeMs += dt
          }
        }
      }
    }
  }

  distanceM = Math.round(distanceM * 10) / 10

  // Elapsed time (from start or first point)
  let elapsedTimeMs = 0
  const firstPtTime = getPointTime(allPoints[0])
  const lastPtTime = getPointTime(allPoints[allPoints.length - 1])

  if (startedAtMs != null) {
    const endT = lastPtTime ?? Date.now()
    elapsedTimeMs = Math.max(0, endT - startedAtMs)
  } else if (firstPtTime != null && lastPtTime != null) {
    elapsedTimeMs = Math.max(0, lastPtTime - firstPtTime)
  }

  // Current speed from latest point
  let currentSpeed = 0
  const lastSeg = segments[segments.length - 1]
  if (Array.isArray(lastSeg) && lastSeg.length > 0) {
    const lastPt = lastSeg[lastSeg.length - 1]
    if (typeof lastPt.speed === 'number' && lastPt.speed >= 0) {
      currentSpeed = lastPt.speed
    } else if (lastSeg.length >= 2) {
      const prevPt = lastSeg[lastSeg.length - 2]
      const tPrev = getPointTime(prevPt)
      const tLast = getPointTime(lastPt)
      if (tPrev != null && tLast != null && tLast > tPrev) {
        const d = haversineDistance(prevPt, lastPt)
        currentSpeed = d / ((tLast - tPrev) / 1000)
      }
    }
  }
  currentSpeed = Math.round(currentSpeed * 100) / 100

  // Average speed in m/s
  let avgSpeed = 0
  const durationSecForSpeed = (movingTimeMs > 0 ? movingTimeMs : elapsedTimeMs) / 1000
  if (distanceM > 0 && durationSecForSpeed > 0) {
    avgSpeed = distanceM / durationSecForSpeed
  }
  avgSpeed = Math.round(avgSpeed * 100) / 100

  // Pace in min/km (or min/mi if imperial)
  const currentPace = currentSpeed > 0 ? Math.round(speedToPace(currentSpeed, unit) * 100) / 100 : 0
  const avgPace = avgSpeed > 0 ? Math.round(speedToPace(avgSpeed, unit) * 100) / 100 : 0

  // Elevation gain
  const eleStats = computeElevationGain(allPoints, {
    smooth: allPoints.length >= 5,
    windowSize: 3,
    threshold: 0.5,
  })
  const elevationGainM = Math.round((eleStats.gain || 0) * 10) / 10

  // Calories
  const calories = Math.round(
    estimateCalories({
      activity,
      weightKg,
      durationSeconds: durationSecForSpeed,
      distanceMeters: distanceM,
      elevationGainM,
    })
  )

  return {
    distanceM,
    movingTimeMs,
    elapsedTimeMs,
    currentPace,
    avgPace,
    currentSpeed,
    avgSpeed,
    elevationGainM,
    calories,
  }
}

/**
 * CardioRecorder manages an individual GPS workout recording session.
 */
export class CardioRecorder {
  constructor(options = {}) {
    this.adapter = options.adapter || null
    this.store = options.store || null
    this.unit = options.unit || 'kg'
    this.weightKg = options.weightKg || 70
    this.movingThreshold = options.movingThreshold ?? DEFAULT_MOVING_SPEED_THRESHOLD

    this.status = RECORDING_STATUS.IDLE
    this.id = null
    this.activityType = 'run'
    this.startTime = null
    this.startedAtMs = null
    this.pausedAtMs = null
    this.totalPausedMs = 0

    this.watchHandle = null
    this.segments = [] // Array<Array<Point>>
    this.points = []   // All valid points flat
    this.liveStats = { ...DEFAULT_LIVE_STATS }
    this.listeners = new Set()
  }

  get isRecording() {
    return this.status === RECORDING_STATUS.RECORDING
  }

  get isPaused() {
    return this.status === RECORDING_STATUS.PAUSED
  }

  get isIdle() {
    return this.status === RECORDING_STATUS.IDLE
  }

  /**
   * Subscribe to state / liveStats updates.
   *
   * @param {Function} listener - Callback invoked on updates
   * @returns {Function} Unsubscribe function
   */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  _notify() {
    const snapshot = this.getState()
    for (const fn of this.listeners) {
      try {
        fn(snapshot)
      } catch (err) {
        console.error('CardioRecorder listener error:', err)
      }
    }
  }

  /**
   * Returns current state snapshot.
   */
  getState() {
    return {
      status: this.status,
      id: this.id,
      activityType: this.activityType,
      startTime: this.startTime,
      startedAtMs: this.startedAtMs,
      isRecording: this.isRecording,
      isPaused: this.isPaused,
      isIdle: this.isIdle,
      pointsCount: this.points.length,
      liveStats: { ...this.liveStats },
    }
  }

  /**
   * Returns current live metrics.
   */
  getLiveStats() {
    return { ...this.liveStats }
  }

  /**
   * Starts a new GPS recording session.
   *
   * @param {Object} [options={}] - Start options (id, type, startTime, adapter, store, unit, weightKg)
   * @returns {Promise<Object>} Current recorder state
   */
  async startRecording(options = {}) {
    // If currently active, discard previous session first
    if (this.status === RECORDING_STATUS.RECORDING || this.status === RECORDING_STATUS.PAUSED) {
      await this.discardRecording()
    }

    this.adapter = options.adapter || this.adapter || getCardioAdapter()
    if (options.store) this.store = options.store
    if (options.unit) this.unit = options.unit
    if (options.weightKg) this.weightKg = options.weightKg

    this.id = options.id || uid()
    this.activityType = options.type || options.activityType || 'run'
    this.startTime = options.startTime
      ? (typeof options.startTime === 'string' ? options.startTime : new Date(options.startTime).toISOString())
      : new Date().toISOString()

    const parsedStart = Date.parse(this.startTime)
    this.startedAtMs = !isNaN(parsedStart) ? parsedStart : Date.now()
    this.pausedAtMs = null
    this.totalPausedMs = 0

    this.segments = [[]]
    this.points = []
    this.liveStats = { ...DEFAULT_LIVE_STATS }
    this.status = RECORDING_STATUS.RECORDING

    // Initialize recovery log
    try {
      await this.adapter.clearRecoveryLog()
      await this.adapter.appendRecoveryLog({
        event: 'start',
        id: this.id,
        type: this.activityType,
        startTime: this.startTime,
      })
    } catch (err) {
      console.warn('CardioRecorder failed to write start event to recovery log:', err)
    }

    // Start GPS watcher
    const watcherOpts = options.watcherOptions || {
      enableHighAccuracy: true,
      distanceFilter: 3,
    }

    this.watchHandle = this.adapter.startWatcher(
      watcherOpts,
      fix => this.onFix(fix),
      err => {
        if (typeof options.onError === 'function') {
          options.onError(err)
        }
      }
    )

    this._notify()
    return this.getState()
  }

  /**
   * Handles an incoming GPS fix.
   * Validates coordinate, appends to recovery log, updates live metrics.
   *
   * @param {Object} fixData - Raw GPS fix object
   * @returns {Promise<Object|null>} Updated live stats or null if skipped
   */
  async onFix(fixData) {
    if (this.status !== RECORDING_STATUS.RECORDING || !fixData) {
      return null
    }

    const rawLat = fixData.lat ?? fixData.latitude ?? fixData.coords?.latitude
    const rawLon = fixData.lon ?? fixData.longitude ?? fixData.coords?.longitude

    if (rawLat == null || rawLon == null) {
      return null
    }

    const lat = Number(rawLat)
    const lon = Number(rawLon)

    if (isNaN(lat) || isNaN(lon) || !isValidCoordinate(lat, lon)) {
      return null
    }

    const norm = normalizeFix(fixData)
    const ele = getPointEle(norm) ?? norm.altitude ?? norm.coords?.altitude ?? null
    const time = getPointTime(norm) || Date.now()
    const speed = typeof norm.speed === 'number' && !isNaN(norm.speed) ? norm.speed : (norm.coords?.speed ?? 0)
    const accuracy = norm.accuracy ?? norm.coords?.accuracy ?? null

    const point = {
      lat,
      lon,
      ele,
      time,
      speed,
      accuracy,
    }

    // Add to current active segment and flat list
    if (this.segments.length === 0) {
      this.segments.push([])
    }
    const currentSegment = this.segments[this.segments.length - 1]
    currentSegment.push(point)
    this.points.push(point)

    // Append to recovery log
    try {
      await this.adapter.appendRecoveryLog(point)
    } catch (err) {
      console.warn('CardioRecorder appendRecoveryLog error:', err)
    }

    // Recompute live stats
    this.liveStats = calculateLiveStats(this.segments, {
      activity: this.activityType,
      unit: this.unit,
      weightKg: this.weightKg,
      movingThreshold: this.movingThreshold,
      startedAtMs: this.startedAtMs,
    })

    this._notify()
    return { ...this.liveStats }
  }

  /**
   * Pauses the active recording session.
   * Incoming fixes will be ignored and not appended to metrics/log.
   *
   * @returns {boolean} True if paused successfully
   */
  pauseRecording() {
    if (this.status !== RECORDING_STATUS.RECORDING) {
      return false
    }

    this.status = RECORDING_STATUS.PAUSED
    this.pausedAtMs = Date.now()

    this._notify()
    return true
  }

  /**
   * Resumes the paused recording session.
   * Starts a new segment so distance between pause and resume locations is not counted.
   *
   * @returns {boolean} True if resumed successfully
   */
  resumeRecording() {
    if (this.status !== RECORDING_STATUS.PAUSED) {
      return false
    }

    if (this.pausedAtMs != null) {
      this.totalPausedMs += Math.max(0, Date.now() - this.pausedAtMs)
      this.pausedAtMs = null
    }

    // Start a new active segment
    this.segments.push([])
    this.status = RECORDING_STATUS.RECORDING

    this._notify()
    return true
  }

  /**
   * Finishes recording:
   * - Stops GPS watcher
   * - Compacts track points with RDP
   * - Computes splits
   * - Writes <year>/<id>.json via adapter
   * - Clears recovery log
   * - Stores activity to openGym store if connected
   * - Returns finalized activity payload
   *
   * @param {Object} [options={}] - Options (notes, gearId, rpe, rdpEpsilon, store)
   * @returns {Promise<Object>} Finalized cardio activity payload
   */
  async finishRecording(options = {}) {
    if (this.status !== RECORDING_STATUS.RECORDING && this.status !== RECORDING_STATUS.PAUSED) {
      throw new Error(`Cannot finish recording: recorder is in '${this.status}' state`)
    }

    // 1. Stop watcher
    if (this.watchHandle != null) {
      this.adapter.stopWatcher(this.watchHandle)
      this.watchHandle = null
    }

    const adapter = this.adapter || getCardioAdapter()
    const allPoints = this.points.slice()

    // 2. Compact points
    const rdpEpsilon = options.rdpEpsilon ?? DEFAULT_RDP_EPSILON
    const compactedPoints = compactTrackPoints(allPoints, rdpEpsilon)

    // 3. Compute splits
    const splits = computeSplits(allPoints, {
      unit: this.unit,
      movingThreshold: this.movingThreshold,
    })

    // 4. File path: <year>/<id>.json
    const d = new Date(this.startTime)
    const year = isNaN(d.getTime()) ? new Date().getUTCFullYear() : d.getUTCFullYear()
    const trackPath = `${year}/${this.id}.json`

    const durationMs = this.liveStats.movingTimeMs || this.liveStats.elapsedTimeMs
    const distanceM = this.liveStats.distanceM

    // Track file payload
    const trackData = {
      id: this.id,
      type: this.activityType,
      startTime: this.startTime,
      endTime: new Date().toISOString(),
      points: compactedPoints,
      splits,
      summary: {
        distanceM,
        movingTimeMs: this.liveStats.movingTimeMs,
        elapsedTimeMs: this.liveStats.elapsedTimeMs,
        avgPace: this.liveStats.avgPace,
        avgSpeed: this.liveStats.avgSpeed,
        elevationGainM: this.liveStats.elevationGainM,
        calories: this.liveStats.calories,
      },
    }

    // 5. Write track file via adapter
    await adapter.writeTrack(trackPath, trackData)

    // 6. Clear recovery log
    await adapter.clearRecoveryLog()

    // 7. Assemble finalized activity payload
    const avgPaceSecKm =
      distanceM > 0 && durationMs > 0 ? durationMs / distanceM : null
    const avgSpeedKmh =
      distanceM > 0 && durationMs > 0 ? (distanceM * 3600) / durationMs : null

    const activity = {
      id: this.id,
      type: this.activityType,
      startTime: this.startTime,
      durationMs,
      distanceM,
      elevationGainM: this.liveStats.elevationGainM,
      avgPaceSecKm: avgPaceSecKm != null && isFinite(avgPaceSecKm) ? avgPaceSecKm : null,
      avgSpeedKmh: avgSpeedKmh != null && isFinite(avgSpeedKmh) ? avgSpeedKmh : null,
      calories: this.liveStats.calories,
      trackPath,
      splits,
      points: compactedPoints,
      liveStats: { ...this.liveStats },
      notes: options.notes ?? '',
      gearId: options.gearId ?? null,
      rpe: options.rpe ?? null,
    }

    // 8. If store is provided or set, log activity
    const targetStore = options.store || this.store
    if (targetStore && typeof targetStore.logCardioActivity === 'function') {
      try {
        targetStore.logCardioActivity(activity)
      } catch (err) {
        console.error('CardioRecorder store.logCardioActivity error:', err)
      }
    }

    // Reset recorder state to idle
    this.status = RECORDING_STATUS.IDLE
    this.watchHandle = null
    this.segments = []
    this.points = []
    this.liveStats = { ...DEFAULT_LIVE_STATS }

    this._notify()
    return activity
  }

  /**
   * Discards the active recording session:
   * - Stops GPS watcher
   * - Clears recovery log
   * - Resets metrics without saving track file
   *
   * @returns {Promise<boolean>} True if discarded
   */
  async discardRecording() {
    if (this.watchHandle != null && this.adapter) {
      this.adapter.stopWatcher(this.watchHandle)
      this.watchHandle = null
    }

    const adapter = this.adapter || getCardioAdapter()
    try {
      await adapter.clearRecoveryLog()
    } catch (err) {
      console.warn('CardioRecorder discard clearRecoveryLog error:', err)
    }

    this.status = RECORDING_STATUS.IDLE
    this.id = null
    this.startTime = null
    this.startedAtMs = null
    this.pausedAtMs = null
    this.totalPausedMs = 0
    this.segments = []
    this.points = []
    this.liveStats = { ...DEFAULT_LIVE_STATS }

    this._notify()
    return true
  }

  /**
   * Reconstructs an interrupted recording session from the recovery log.
   *
   * @param {Object} [options={}] - Options (adapter, autoResume)
   * @returns {Promise<Object|null>} Restored session state or null if empty
   */
  async recoverRecording(options = {}) {
    const adapter = options.adapter || this.adapter || getCardioAdapter()
    const log = await adapter.readRecoveryLog()

    if (!log || log.length === 0) {
      return null
    }

    const items = typeof log.parsed === 'function' ? log.parsed() : log
    let startMeta = null
    const recoveredPoints = []

    for (const item of items) {
      if (!item) continue
      const obj = typeof item === 'string' ? JSON.parse(item) : item
      if (obj.event === 'start') {
        startMeta = obj
      } else if (isValidPoint(obj)) {
        recoveredPoints.push(obj)
      }
    }

    if (!startMeta && recoveredPoints.length === 0) {
      return null
    }

    this.id = startMeta?.id || uid()
    this.activityType = startMeta?.type || 'run'
    this.startTime = startMeta?.startTime || (recoveredPoints[0]?.time ? new Date(recoveredPoints[0].time).toISOString() : new Date().toISOString())
    this.startedAtMs = Date.parse(this.startTime) || Date.now()
    this.adapter = adapter

    this.points = recoveredPoints
    this.segments = [recoveredPoints.slice()]
    this.status = options.autoResume ? RECORDING_STATUS.RECORDING : RECORDING_STATUS.PAUSED

    this.liveStats = calculateLiveStats(this.segments, {
      activity: this.activityType,
      unit: this.unit,
      weightKg: this.weightKg,
      movingThreshold: this.movingThreshold,
      startedAtMs: this.startedAtMs,
    })

    this._notify()
    return this.getState()
  }
}

/**
 * Factory function to create a new isolated CardioRecorder instance.
 */
export function createCardioRecorder(options = {}) {
  return new CardioRecorder(options)
}

// ---------------------------------------------------------------------------
// Singleton Default Recorder Instance & Convenience Exports
// ---------------------------------------------------------------------------

let _defaultRecorder = null
let _globalStore = null

export function getCardioRecorder() {
  if (!_defaultRecorder) {
    _defaultRecorder = new CardioRecorder({ store: _globalStore })
  }
  return _defaultRecorder
}

export function setCardioStore(store) {
  _globalStore = store
  if (_defaultRecorder) {
    _defaultRecorder.store = store
  }
}

export function startRecording(options = {}) {
  return getCardioRecorder().startRecording(options)
}

export function onFix(fixData) {
  return getCardioRecorder().onFix(fixData)
}

export const handleFix = onFix

export function pauseRecording() {
  return getCardioRecorder().pauseRecording()
}

export function resumeRecording() {
  return getCardioRecorder().resumeRecording()
}

export function finishRecording(options = {}) {
  return getCardioRecorder().finishRecording(options)
}

export function discardRecording() {
  return getCardioRecorder().discardRecording()
}

export function getRecordingState() {
  return getCardioRecorder().getState()
}

export const getState = getRecordingState

export function getLiveStats() {
  return getCardioRecorder().getLiveStats()
}

export function isRecording() {
  return getCardioRecorder().isRecording
}

export function isPaused() {
  return getCardioRecorder().isPaused
}

export function isIdle() {
  return getCardioRecorder().isIdle
}

export function subscribe(fn) {
  return getCardioRecorder().subscribe(fn)
}

export function recoverRecording(options = {}) {
  return getCardioRecorder().recoverRecording(options)
}
