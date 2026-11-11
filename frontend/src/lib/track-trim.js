// Post-activity GPS track trimming and track file deletion cleanup (Issue #65).
//
// Provides:
//   1. trimTrack(track, startIndex, endIndex, options):
//      Slices GPS track points to [startIndex, endIndex] and recalculates
//      all metrics (distance, duration, elevation, pace, splits, summary).
//   2. deleteTrackFile(path, adapter):
//      Removes <year>/<id>.json track file via cardio device adapter.
//   3. resolveTrackPath(path):
//      Resolves a string or object reference into normalized track file path.
//   4. canTrimTrack(track):
//      Predicate checking if track contains enough valid points to be trimmed.

import {
  getPointTime,
  isValidPoint,
  analyzeTrack,
  totalDistance,
  computeElapsedTime,
  computeMovingTime,
  computeElevationGain,
  computeSplits,
  speedToPace,
  DEFAULT_MOVING_SPEED_THRESHOLD,
  DEFAULT_ELEVATION_WINDOW,
  DEFAULT_RDP_EPSILON,
} from './track-math.js'

import {
  normalizeTrackPath,
  getCardioAdapter,
} from './cardio-adapter.js'

/**
 * Resolves a track path string or activity/track object to a normalized path.
 * Supports:
 *   - "2026/abc-123.json" -> "2026/abc-123.json"
 *   - "tracks/2026/abc-123.json" -> "tracks/2026/abc-123.json"
 *   - { trackPath: "2026/abc-123.json" } -> "2026/abc-123.json"
 *   - { path: "2026/abc-123.json" } -> "2026/abc-123.json"
 *   - { year: 2026, id: "abc-123" } -> "2026/abc-123.json"
 *   - { startTime: "2026-05-01T00:00:00Z", id: "abc-123" } -> "2026/abc-123.json"
 *   - { id: "abc-123" } -> "abc-123.json"
 *
 * @param {string|Object} path - Path string or descriptor object
 * @returns {string} Normalized track file path or empty string
 */
export function resolveTrackPath(path) {
  if (!path) return ''
  if (typeof path === 'string') {
    return normalizeTrackPath(path)
  }
  if (typeof path === 'object') {
    if (path.trackPath) return normalizeTrackPath(path.trackPath)
    if (path.path) return normalizeTrackPath(path.path)
    if (path.id) {
      let year = path.year
      if (!year && path.startTime) {
        const d = new Date(path.startTime)
        if (!isNaN(d.getTime())) {
          year = d.getUTCFullYear()
        }
      }
      if (year) {
        return `${year}/${path.id}.json`
      }
      return `${path.id}.json`
    }
  }
  return ''
}

/**
 * Deletes a persisted GPS track file (<year>/<id>.json) using the specified
 * or default cardio adapter.
 *
 * @param {string|Object} path - File path or activity object with path/id
 * @param {Object} [adapter] - Cardio adapter instance with deleteTrack method
 * @returns {Promise<boolean>} True if successfully deleted, false otherwise
 */
export async function deleteTrackFile(path, adapter) {
  // Support flipped arguments gracefully
  let targetPath = path
  let targetAdapter = adapter

  if (
    path &&
    typeof path.deleteTrack === 'function' &&
    (!adapter || typeof adapter.deleteTrack !== 'function')
  ) {
    targetAdapter = path
    targetPath = adapter
  }

  const ad = targetAdapter || getCardioAdapter()
  if (!ad || typeof ad.deleteTrack !== 'function') {
    return false
  }

  const resolved = resolveTrackPath(targetPath)
  if (!resolved) {
    return false
  }

  try {
    return Boolean(await ad.deleteTrack(resolved))
  } catch (err) {
    console.warn('deleteTrackFile failed:', err)
    return false
  }
}

/**
 * Checks if a track or points array contains enough points to trim.
 *
 * @param {Object|Array} track - Track object or array of points
 * @returns {boolean} True if track has at least 2 points
 */
export function canTrimTrack(track) {
  if (!track) return false
  const points = Array.isArray(track)
    ? track
    : Array.isArray(track.points)
      ? track.points
      : Array.isArray(track.coordinates)
        ? track.coordinates
        : null
  return Array.isArray(points) && points.length >= 2
}

/**
 * Trims a GPS track between startIndex and endIndex (inclusive) and
 * recalculates all metrics: distance, duration, elevation, pace, and splits.
 *
 * Edge cases handled safely:
 *   - Empty, null, or undefined track
 *   - startIndex > endIndex -> returns 0 points and zeroed metrics
 *   - startIndex === endIndex -> returns 1 point and zeroed metrics
 *   - Out of bounds indices clamped safely
 *
 * @param {Object|Array} track - Track object (with points) or array of points
 * @param {number} [startIndex=0] - 0-based start index (inclusive)
 * @param {number} [endIndex] - 0-based end index (inclusive, defaults to last point)
 * @param {Object} [options={}] - Recalculation options (unit, activity, movingThreshold, etc.)
 * @returns {Object|Array} Trimmed track object with re-calculated metrics
 */
export function trimTrack(track, startIndex, endIndex, options = {}) {
  const isArrayInput = Array.isArray(track)
  const isObjectInput = typeof track === 'object' && track !== null && !isArrayInput

  const rawPoints = isArrayInput
    ? track
    : isObjectInput
      ? (Array.isArray(track.points)
          ? track.points
          : Array.isArray(track.coordinates)
            ? track.coordinates
            : [])
      : []

  const totalRawCount = rawPoints.length

  // Slicing logic with boundary normalization
  let trimmedPoints = []

  if (totalRawCount > 0) {
    let start = startIndex == null ? 0 : Number(startIndex)
    let end = endIndex == null ? totalRawCount - 1 : Number(endIndex)

    if (isNaN(start)) start = 0
    if (isNaN(end)) end = totalRawCount - 1

    // Clamp boundaries
    const clampedStart = Math.max(0, start)
    const clampedEnd = Math.min(totalRawCount - 1, end)

    if (start <= end && clampedStart <= clampedEnd && clampedStart < totalRawCount && clampedEnd >= 0) {
      trimmedPoints = rawPoints.slice(clampedStart, clampedEnd + 1)
    } else {
      // start > end or entirely out of bounds: safely produces 0 points
      trimmedPoints = []
    }
  }

  // Activity & metric options
  const unit = options.unit || (isObjectInput ? track.unit : 'kg') || 'kg'
  const activity = options.activity || (isObjectInput ? (track.type || track.activity) : 'run') || 'run'
  const movingThreshold = options.movingThreshold ?? (isObjectInput ? track.movingThreshold : DEFAULT_MOVING_SPEED_THRESHOLD)
  const elevationWindow = options.elevationWindow ?? (isObjectInput ? track.elevationWindow : DEFAULT_ELEVATION_WINDOW)
  const rdpEpsilon = options.rdpEpsilon ?? (isObjectInput ? track.rdpEpsilon : DEFAULT_RDP_EPSILON)
  const weightKg = options.weightKg || (isObjectInput ? track.weightKg : 70) || 70

  // Normalize points for track-math if altitude field is used
  const normalizedPoints = trimmedPoints.map(p => {
    if (p && typeof p === 'object' && !Array.isArray(p) && p.ele == null && p.alt == null && p.elevation == null && p.altitude != null) {
      return { ...p, ele: p.altitude }
    }
    return p
  })

  // Run comprehensive analysis
  const analysis = analyzeTrack(normalizedPoints, {
    activity,
    unit,
    weightKg,
    movingThreshold,
    elevationWindow,
    rdpEpsilon,
    ...options,
  })

  const distanceM = analysis.totalDistance
  const elapsedSec = analysis.elapsedTime
  const movingSec = analysis.movingTime
  const elapsedMs = Math.round(elapsedSec * 1000)
  const movingMs = Math.round(movingSec * 1000)
  const durationSec = movingSec > 0 ? movingSec : elapsedSec
  const durationMs = movingMs > 0 ? movingMs : elapsedMs

  const elevationGainM = analysis.elevationGain
  const elevationLossM = analysis.elevationLoss
  const avgPace = analysis.avgPace
  const movingPace = analysis.movingPace
  const avgSpeed = analysis.avgSpeed
  const avgMovingSpeed = analysis.avgMovingSpeed
  const splits = analysis.splits.map(s => ({
    ...s,
    splitIndex: s.splitIndex ?? s.split,
  }))
  const calories = analysis.calories

  // Calculate updated start/end timestamps if valid points exist
  let newStartTime = null
  let newEndTime = null

  if (trimmedPoints.length > 0) {
    const t0 = getPointTime(trimmedPoints[0])
    const t1 = getPointTime(trimmedPoints[trimmedPoints.length - 1])

    if (t0 != null) {
      newStartTime = typeof track?.startTime === 'number' ? t0 : new Date(t0).toISOString()
    } else if (track?.startTime) {
      newStartTime = track.startTime
    }

    if (t1 != null) {
      newEndTime = typeof track?.endTime === 'number' ? t1 : new Date(t1).toISOString()
    } else if (track?.endTime) {
      newEndTime = track.endTime
    }
  }

  // Build summary object
  const summary = {
    ...(isObjectInput && track.summary ? track.summary : {}),
    pointCount: trimmedPoints.length,
    distanceM,
    totalDistance: distanceM,
    duration: durationSec,
    durationMs,
    elapsedTime: elapsedSec,
    elapsedTimeMs: elapsedMs,
    movingTime: movingSec,
    movingTimeMs: movingMs,
    avgPace,
    movingPace,
    avgSpeed,
    avgMovingSpeed,
    elevationGainM,
    elevationLossM,
    minElevation: analysis.minElevation,
    maxElevation: analysis.maxElevation,
    calories,
  }

  // Base result object
  const result = {
    ...(isObjectInput ? track : {}),
    points: trimmedPoints,
    distance: distanceM,
    distanceM,
    totalDistance: distanceM,
    duration: durationSec,
    durationMs,
    elapsedTime: elapsedSec,
    elapsedTimeMs: elapsedMs,
    movingTime: movingSec,
    movingTimeMs: movingMs,
    elevation: elevationGainM,
    elevationGain: elevationGainM,
    elevationGainM,
    elevationLoss: elevationLossM,
    elevationLossM,
    minElevation: analysis.minElevation,
    maxElevation: analysis.maxElevation,
    pace: avgPace,
    avgPace,
    movingPace,
    avgSpeed,
    avgMovingSpeed,
    splits,
    calories,
    summary,
  }

  if (trimmedPoints.length > 0) {
    if (newStartTime != null) result.startTime = newStartTime
    if (newEndTime != null) result.endTime = newEndTime
  } else {
    result.startTime = null
    result.endTime = null
  }

  // For array inputs, also provide array-like behavior
  if (isArrayInput) {
    Object.defineProperty(result, 'length', {
      value: trimmedPoints.length,
      writable: false,
      enumerable: false,
    })
    result[Symbol.iterator] = function* () {
      yield* trimmedPoints
    }
    for (let i = 0; i < trimmedPoints.length; i++) {
      Object.defineProperty(result, i, {
        value: trimmedPoints[i],
        enumerable: false,
      })
    }
  }

  return result
}
