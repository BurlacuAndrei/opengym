/**
 * OpenGym Cardio Boot Recovery & Crash-Safe Append Log Subsystem (Issue #63)
 *
 * Implements crash-safe active recording append log (active.jsonl streaming)
 * and boot recovery checks for interrupted cardio sessions.
 *
 * Capabilities:
 * - Stream serialization: writes one JSON line per GPS fix point
 * - Boot recovery check: checkRecoveryLog(adapter) parses log and reconstructs session
 * - Options on recovery: resume recording or finish & save recovered points
 * - Fault tolerance: gracefully ignores corrupted/partial lines on crash
 * - Full cleanup on finish or discard
 */

import { getCardioAdapter } from './cardio-adapter.js'
import {
  calculateLiveStats,
  compactTrackPoints,
  createCardioRecorder,
  getCardioRecorder,
  RECORDING_STATUS,
  DEFAULT_LIVE_STATS,
} from './cardio-recording.js'
import {
  isValidPoint,
  getPointLat,
  getPointLon,
  getPointEle,
  getPointTime,
  computeSplits,
  DEFAULT_RDP_EPSILON,
  DEFAULT_MOVING_SPEED_THRESHOLD,
} from './track-math.js'
import { uid } from './format.js'

/**
 * Standard log file name for streaming GPS points during active recording.
 */
export const ACTIVE_LOG_FILENAME = 'active.jsonl'

/**
 * Normalizes a raw GPS point or coordinate into a standard point format.
 *
 * @param {Object} p - Raw GPS point or coordinates
 * @returns {Object} Normalized point object
 */
export function normalizePoint(p) {
  const lat = getPointLat(p)
  const lon = getPointLon(p)
  let ele = getPointEle(p)
  if (ele == null && p.altitude != null && !Number.isNaN(Number(p.altitude))) {
    ele = Number(p.altitude)
  }
  const time = getPointTime(p) || Date.now()

  const speed =
    typeof p.speed === 'number' && Number.isFinite(p.speed)
      ? Number(p.speed.toFixed(2))
      : null
  const accuracy =
    typeof p.accuracy === 'number' && Number.isFinite(p.accuracy)
      ? Number(p.accuracy.toFixed(1))
      : null
  const heading =
    typeof p.heading === 'number' && Number.isFinite(p.heading)
      ? Number(p.heading.toFixed(1))
      : null

  return {
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    ele: ele != null ? Number(ele.toFixed(1)) : null,
    time,
    speed,
    accuracy,
    heading,
  }
}

/**
 * Serializes a GPS fix point to a single-line JSON string for append log streaming.
 *
 * @param {Object} point - GPS fix point
 * @returns {string} Single JSON line representation
 */
export function serializeRecoveryPoint(point) {
  if (!point || typeof point !== 'object') {
    throw new TypeError('serializeRecoveryPoint requires a point object')
  }
  const normalized = isValidPoint(point) ? normalizePoint(point) : point
  return JSON.stringify(normalized)
}

/**
 * Serializes an event payload (start, pause, resume, etc.) to a single-line JSON string.
 *
 * @param {string} event - Event name ('start', 'pause', 'resume', etc.)
 * @param {Object} [data={}] - Additional event metadata
 * @returns {string} Single JSON line representation
 */
export function serializeRecoveryEvent(event, data = {}) {
  if (typeof event !== 'string' || !event.trim()) {
    throw new TypeError('serializeRecoveryEvent requires a non-empty event name')
  }
  const payload = {
    event,
    timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
    ...data,
  }
  return JSON.stringify(payload)
}

/**
 * Appends a GPS fix point to the active recovery log via the cardio adapter.
 *
 * @param {Object} adapter - Cardio adapter
 * @param {Object} point - GPS fix point
 * @returns {Promise<boolean>} Success indicator
 */
export async function appendRecoveryPoint(adapter, point) {
  const targetAdapter = adapter || getCardioAdapter()
  const line = serializeRecoveryPoint(point)
  return targetAdapter.appendRecoveryLog(line)
}

/**
 * Appends a lifecycle event to the active recovery log via the cardio adapter.
 *
 * @param {Object} adapter - Cardio adapter
 * @param {string} event - Event name ('start', 'pause', 'resume')
 * @param {Object} [data={}] - Metadata
 * @returns {Promise<boolean>} Success indicator
 */
export async function appendRecoveryEvent(adapter, event, data = {}) {
  const targetAdapter = adapter || getCardioAdapter()
  const line = serializeRecoveryEvent(event, data)
  return targetAdapter.appendRecoveryLog(line)
}

/**
 * Parses raw recovery log contents into structured start metadata, points, and segments.
 * Tolerates corrupted or truncated lines (such as partial JSON from an abrupt crash).
 *
 * @param {string|Array} rawLog - Raw log text, lines array, or RecoveryLog instance
 * @returns {Object} Parsed session components and error counters
 */
export function parseRecoveryLog(rawLog) {
  if (!rawLog) {
    return {
      startMeta: null,
      points: [],
      segments: [],
      events: [],
      corruptedLinesCount: 0,
      totalLinesCount: 0,
    }
  }

  let lines = []
  if (typeof rawLog === 'string') {
    lines = rawLog.split('\n')
  } else if (Array.isArray(rawLog)) {
    lines = rawLog
  } else if (typeof rawLog.split === 'function') {
    lines = rawLog.split('\n')
  } else if (typeof rawLog.lines === 'function') {
    lines = rawLog.lines()
  } else {
    lines = [rawLog]
  }

  let startMeta = null
  const points = []
  let currentSegment = []
  const segments = []
  const events = []
  let corruptedLinesCount = 0
  let totalLinesCount = 0

  for (const rawLine of lines) {
    if (rawLine === null || rawLine === undefined) continue
    if (typeof rawLine === 'string' && rawLine.trim() === '') continue

    totalLinesCount++

    let item
    if (typeof rawLine === 'object') {
      item = rawLine
    } else if (typeof rawLine === 'string') {
      try {
        item = JSON.parse(rawLine.trim())
      } catch {
        // Corrupted or truncated JSON line (e.g. crash during write)
        corruptedLinesCount++
        continue
      }
    } else {
      corruptedLinesCount++
      continue
    }

    if (!item || typeof item !== 'object') {
      corruptedLinesCount++
      continue
    }

    if (item.event === 'start') {
      startMeta = item
      events.push(item)
    } else if (item.event === 'pause') {
      events.push(item)
      if (currentSegment.length > 0) {
        segments.push(currentSegment)
        currentSegment = []
      }
    } else if (item.event === 'resume') {
      events.push(item)
      if (currentSegment.length > 0) {
        segments.push(currentSegment)
        currentSegment = []
      }
    } else if (item.event === 'stop' || item.event === 'finish') {
      events.push(item)
      if (currentSegment.length > 0) {
        segments.push(currentSegment)
        currentSegment = []
      }
    } else {
      const candidate = item.point || item
      if (isValidPoint(candidate)) {
        const normalized = normalizePoint(candidate)
        points.push(normalized)
        currentSegment.push(normalized)
      } else if (item.event) {
        events.push(item)
      } else {
        corruptedLinesCount++
      }
    }
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment)
  }

  const finalSegments =
    segments.length > 0 ? segments : points.length > 0 ? [points] : []

  return {
    startMeta,
    points,
    segments: finalSegments,
    events,
    corruptedLinesCount,
    totalLinesCount,
  }
}

/**
 * Checks the cardio recovery log on boot/startup for an interrupted session.
 * Reconstructs the activity session with live metrics and action handlers.
 *
 * @param {Object} [adapter=getCardioAdapter()] - Cardio adapter to inspect
 * @returns {Promise<Object|null>} Reconstructed activity session or null if no recovery
 */
export async function checkRecoveryLog(adapter = getCardioAdapter()) {
  if (!adapter || typeof adapter.readRecoveryLog !== 'function') {
    return null
  }

  let log
  try {
    log = await adapter.readRecoveryLog()
  } catch (err) {
    console.warn('Failed to read cardio recovery log:', err)
    return null
  }

  if (!log || (Array.isArray(log) && log.length === 0)) {
    return null
  }
  if (typeof log === 'string' && log.trim().length === 0) {
    return null
  }

  const parsed = parseRecoveryLog(log)

  // If there's neither a start event nor any valid recovered points, no recovery
  if (!parsed.startMeta && parsed.points.length === 0) {
    return null
  }

  const startMeta = parsed.startMeta
  const firstPt = parsed.points[0]
  const lastPt = parsed.points[parsed.points.length - 1]

  const id = startMeta?.id || uid()
  const activityType = startMeta?.type || 'run'
  const startTime =
    startMeta?.startTime ||
    (firstPt?.time
      ? new Date(firstPt.time).toISOString()
      : new Date().toISOString())
  const startedAtMs = Date.parse(startTime) || (firstPt?.time ?? Date.now())
  const endTime = lastPt?.time
    ? new Date(lastPt.time).toISOString()
    : new Date().toISOString()

  const liveStats = calculateLiveStats(parsed.segments, {
    activity: activityType,
    startedAtMs,
  })

  const session = {
    id,
    type: activityType,
    activityType,
    startTime,
    startedAtMs,
    endTime,
    points: parsed.points,
    segments: parsed.segments,
    pointsCount: parsed.points.length,
    liveStats,
    stats: liveStats,
    startMeta,
    events: parsed.events,
    corruptedLinesCount: parsed.corruptedLinesCount,
    totalLinesCount: parsed.totalLinesCount,
    adapter,
    hasRecovery: true,
  }

  // Bind convenience methods to this session
  session.resume = (options = {}) =>
    resumeRecoveredSession(session, { adapter, ...options })
  session.finish = (options = {}) =>
    finishRecoveredSession(session, { adapter, ...options })
  session.discard = () => discardRecoveredSession(session)

  return session
}

/**
 * Resumes recording for an interrupted session. Populates the recorder state
 * and transitions status to RECORDING (or PAUSED if autoResume is false).
 *
 * @param {Object} session - Reconstructed session from checkRecoveryLog
 * @param {Object} [options={}] - Options (recorder, adapter, store, autoResume, startWatcher)
 * @returns {Promise<Object>} Resumed recorder instance
 */
export async function resumeRecoveredSession(session, options = {}) {
  if (!session) {
    throw new Error('resumeRecoveredSession requires a recovered session object')
  }

  const adapter = options.adapter || session.adapter || getCardioAdapter()
  let recorder = options.recorder

  if (!recorder) {
    if (typeof options.createRecorder === 'function') {
      recorder = options.createRecorder({ adapter, store: options.store })
    } else if (options.useSingleton) {
      recorder = getCardioRecorder()
    } else {
      recorder = createCardioRecorder({ adapter, store: options.store })
    }
  }

  recorder.id = session.id
  recorder.activityType = session.activityType || session.type || 'run'
  recorder.startTime = session.startTime || new Date().toISOString()
  recorder.startedAtMs =
    session.startedAtMs || Date.parse(recorder.startTime) || Date.now()
  recorder.adapter = adapter

  if (options.store) {
    recorder.store = options.store
  }

  recorder.points = (session.points || []).slice()
  recorder.segments =
    session.segments && session.segments.length > 0
      ? session.segments.map(seg => seg.slice())
      : [recorder.points.slice()]

  const autoResume = options.autoResume !== false
  recorder.status = autoResume
    ? RECORDING_STATUS.RECORDING
    : RECORDING_STATUS.PAUSED

  recorder.liveStats = {
    ...(session.liveStats ||
      calculateLiveStats(recorder.segments, {
        activity: recorder.activityType,
        unit: recorder.unit,
        weightKg: recorder.weightKg,
        movingThreshold: recorder.movingThreshold,
        startedAtMs: recorder.startedAtMs,
      })),
  }

  // Start GPS watcher if auto-resuming
  if (
    autoResume &&
    options.startWatcher !== false &&
    adapter &&
    typeof adapter.startWatcher === 'function' &&
    !recorder.watchHandle
  ) {
    const watcherOpts = options.watcherOptions || {
      enableHighAccuracy: true,
      distanceFilter: 3,
    }
    recorder.watchHandle = adapter.startWatcher(
      watcherOpts,
      fix => recorder.onFix(fix),
      err => {
        if (typeof options.onError === 'function') {
          options.onError(err)
        }
      }
    )
  }

  if (typeof recorder._notify === 'function') {
    recorder._notify()
  }

  return recorder
}

/**
 * Finishes an interrupted session and saves recovered points to disk/storage.
 * Compacting points, computing splits, persisting track file, and clearing the recovery log.
 *
 * @param {Object} session - Reconstructed session from checkRecoveryLog
 * @param {Object} [options={}] - Options (adapter, store, rdpEpsilon, notes, gearId, rpe)
 * @returns {Promise<Object>} Finalized activity payload
 */
export async function finishRecoveredSession(session, options = {}) {
  if (!session) {
    throw new Error('finishRecoveredSession requires a recovered session object')
  }

  const adapter = options.adapter || session.adapter || getCardioAdapter()
  const allPoints = (session.points || []).slice()

  // 1. Compact points
  const rdpEpsilon = options.rdpEpsilon ?? DEFAULT_RDP_EPSILON
  const compactedPoints = compactTrackPoints(allPoints, rdpEpsilon)

  // 2. Compute splits
  const splits = computeSplits(allPoints, {
    unit: options.unit || 'kg',
    movingThreshold:
      options.movingThreshold || DEFAULT_MOVING_SPEED_THRESHOLD,
  })

  // 3. File path: <year>/<id>.json
  const d = new Date(session.startTime)
  const year = isNaN(d.getTime()) ? new Date().getUTCFullYear() : d.getUTCFullYear()
  const trackPath = `${year}/${session.id}.json`

  const stats = session.liveStats || DEFAULT_LIVE_STATS
  const durationMs = stats.movingTimeMs || stats.elapsedTimeMs || 0
  const distanceM = stats.distanceM || 0

  // 4. Track file payload
  const trackData = {
    id: session.id,
    type: session.activityType || session.type || 'run',
    startTime: session.startTime,
    endTime: session.endTime || new Date().toISOString(),
    points: compactedPoints,
    splits,
    summary: {
      distanceM,
      movingTimeMs: stats.movingTimeMs || 0,
      elapsedTimeMs: stats.elapsedTimeMs || 0,
      avgPace: stats.avgPace || 0,
      avgSpeed: stats.avgSpeed || 0,
      elevationGainM: stats.elevationGainM || 0,
      calories: stats.calories || 0,
    },
  }

  // 5. Persist track file via adapter
  if (typeof adapter.writeTrack === 'function') {
    await adapter.writeTrack(trackPath, trackData)
  }

  // 6. Clear recovery log
  if (typeof adapter.clearRecoveryLog === 'function') {
    await adapter.clearRecoveryLog()
  }

  // 7. Assemble finalized activity payload
  const avgPaceSecKm =
    distanceM > 0 && durationMs > 0 ? durationMs / distanceM : null
  const avgSpeedKmh =
    distanceM > 0 && durationMs > 0 ? (distanceM * 3600) / durationMs : null

  const activity = {
    id: session.id,
    type: session.activityType || session.type || 'run',
    startTime: session.startTime,
    durationMs,
    distanceM,
    elevationGainM: stats.elevationGainM || 0,
    avgPaceSecKm:
      avgPaceSecKm != null && isFinite(avgPaceSecKm) ? avgPaceSecKm : null,
    avgSpeedKmh:
      avgSpeedKmh != null && isFinite(avgSpeedKmh) ? avgSpeedKmh : null,
    calories: stats.calories || 0,
    trackPath,
    splits,
    points: compactedPoints,
    liveStats: { ...stats },
    notes: options.notes ?? '',
    gearId: options.gearId ?? null,
    rpe: options.rpe ?? null,
  }

  // 8. Log activity to store if provided
  const targetStore = options.store
  if (targetStore && typeof targetStore.logCardioActivity === 'function') {
    try {
      targetStore.logCardioActivity(activity)
    } catch (err) {
      console.error('CardioRecovery store.logCardioActivity error:', err)
    }
  }

  return activity
}

/**
 * Discards the recovered session and clears the recovery log.
 *
 * @param {Object} sessionOrAdapter - Session object or cardio adapter
 * @returns {Promise<boolean>} Success indicator
 */
export async function discardRecoveredSession(sessionOrAdapter) {
  const adapter =
    sessionOrAdapter && sessionOrAdapter.adapter
      ? sessionOrAdapter.adapter
      : sessionOrAdapter && typeof sessionOrAdapter.clearRecoveryLog === 'function'
      ? sessionOrAdapter
      : getCardioAdapter()

  if (adapter && typeof adapter.clearRecoveryLog === 'function') {
    return adapter.clearRecoveryLog()
  }
  return true
}

/**
 * Convenience alias to clear the recovery log on an adapter.
 *
 * @param {Object} [adapter=getCardioAdapter()] - Cardio adapter
 * @returns {Promise<boolean>} Success indicator
 */
export async function clearRecoveryLog(adapter = getCardioAdapter()) {
  return discardRecoveredSession(adapter)
}
