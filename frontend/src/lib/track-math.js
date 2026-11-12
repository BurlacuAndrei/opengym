// Pure GPS track math functions (Issue #46).
// Handles Haversine distance, rolling pace/speed, moving time filtering,
// windowed elevation smoothing, split computation (metric & imperial),
// MET-based calorie estimation, and Ramer-Douglas-Peucker (RDP) compaction.
//
// Zero DOM/browser dependencies — pure mathematical calculations.

// Earth constants
export const EARTH_RADIUS_METERS = 6371000
export const METERS_PER_KM = 1000
export const METERS_PER_MILE = 1609.344
export const METERS_PER_FOOT = 0.3048
export const FEET_PER_METER = 1 / 0.3048
export const LBS_PER_KG = 2.20462262185

// Default thresholds & parameters
export const DEFAULT_MOVING_SPEED_THRESHOLD = 0.5 // m/s (~1.8 km/h)
export const DEFAULT_RDP_EPSILON = 5 // meters
export const DEFAULT_ELEVATION_WINDOW = 5 // points
export const DEFAULT_ELEVATION_THRESHOLD = 1.0 // meters

// Base MET (Metabolic Equivalent of Task) values by activity
export const MET_BY_ACTIVITY = {
  run: 9.8,
  running: 9.8,
  ride: 7.5,
  bike: 7.5,
  cycling: 7.5,
  hike: 6.0,
  hiking: 6.0,
  walk: 3.8,
  walking: 3.8,
}

// ---------------------------------------------------------------------------
// Coordinate & Point Normalization Helpers
// ---------------------------------------------------------------------------

/**
 * Extract latitude from various point structures ({lat, lon}, {latitude, longitude}, [lat, lon]).
 * Returns null if invalid or missing.
 */
export function getPointLat(p) {
  if (p == null) return null
  let val
  if (typeof p.lat === 'number') val = p.lat
  else if (typeof p.latitude === 'number') val = p.latitude
  else if (Array.isArray(p) && typeof p[0] === 'number') val = p[0]
  else if (p.lat != null) val = Number(p.lat)
  else if (p.latitude != null) val = Number(p.latitude)
  else if (Array.isArray(p) && p[0] != null) val = Number(p[0])

  if (val == null || Number.isNaN(val) || val < -90 || val > 90) return null
  return val
}

/**
 * Extract longitude from various point structures ({lat, lon}, {lat, lng}, [lat, lon]).
 * Returns null if invalid or missing.
 */
export function getPointLon(p) {
  if (p == null) return null
  let val
  if (typeof p.lon === 'number') val = p.lon
  else if (typeof p.lng === 'number') val = p.lng
  else if (typeof p.longitude === 'number') val = p.longitude
  else if (Array.isArray(p) && typeof p[1] === 'number') val = p[1]
  else if (p.lon != null) val = Number(p.lon)
  else if (p.lng != null) val = Number(p.lng)
  else if (p.longitude != null) val = Number(p.longitude)
  else if (Array.isArray(p) && p[1] != null) val = Number(p[1])

  if (val == null || Number.isNaN(val) || val < -180 || val > 180) return null
  return val
}

/**
 * Extract elevation (in meters) from point. Returns null if missing or invalid.
 */
export function getPointEle(p) {
  if (p == null) return null
  let val
  if (typeof p.ele === 'number') val = p.ele
  else if (typeof p.alt === 'number') val = p.alt
  else if (typeof p.elevation === 'number') val = p.elevation
  else if (Array.isArray(p) && typeof p[2] === 'number') val = p[2]
  else if (p.ele != null) val = Number(p.ele)
  else if (p.alt != null) val = Number(p.alt)
  else if (p.elevation != null) val = Number(p.elevation)
  else if (Array.isArray(p) && p[2] != null) val = Number(p[2])

  if (val == null || Number.isNaN(val) || !Number.isFinite(val)) return null
  return val
}

/**
 * Extract timestamp (in epoch milliseconds) from point. Returns null if missing.
 */
export function getPointTime(p) {
  if (p == null) return null
  let val
  if (typeof p.time === 'number') val = p.time
  else if (typeof p.timestamp === 'number') val = p.timestamp
  else if (typeof p.t === 'number') val = p.t
  else if (p.time instanceof Date) val = p.time.getTime()
  else if (p.timestamp instanceof Date) val = p.timestamp.getTime()
  else if (typeof p.time === 'string') val = Date.parse(p.time)
  else if (typeof p.timestamp === 'string') val = Date.parse(p.timestamp)
  else if (Array.isArray(p) && typeof p[3] === 'number') val = p[3]

  if (val == null || Number.isNaN(val) || !Number.isFinite(val)) return null
  // If timestamp looks like epoch seconds (between 2001 and 2065: 1e9 to 3e9), convert to ms
  if (val >= 1000000000 && val <= 3000000000) return val * 1000
  return val
}

/**
 * Check if a coordinate pair is valid.
 */
export function isValidCoordinate(lat, lon) {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  )
}

/**
 * Check if a point object has valid coordinates.
 */
export function isValidPoint(p) {
  const lat = getPointLat(p)
  const lon = getPointLon(p)
  return lat != null && lon != null
}

// ---------------------------------------------------------------------------
// 1. Haversine Distance
// ---------------------------------------------------------------------------

const toRad = deg => (deg * Math.PI) / 180

/**
 * Compute Haversine distance in meters between two points.
 * Supports:
 *   haversineDistance(p1, p2)
 *   haversineDistance(lat1, lon1, lat2, lon2)
 * Returns 0 if coordinates are invalid, missing, or identical.
 */
export function haversineDistance(arg1, arg2, arg3, arg4) {
  let lat1, lon1, lat2, lon2

  if (arg3 !== undefined && arg4 !== undefined) {
    lat1 = Number(arg1)
    lon1 = Number(arg2)
    lat2 = Number(arg3)
    lon2 = Number(arg4)
  } else {
    lat1 = getPointLat(arg1)
    lon1 = getPointLon(arg1)
    lat2 = getPointLat(arg2)
    lon2 = getPointLon(arg2)
  }

  if (
    lat1 == null ||
    lon1 == null ||
    lat2 == null ||
    lon2 == null ||
    !isValidCoordinate(lat1, lon1) ||
    !isValidCoordinate(lat2, lon2)
  ) {
    return 0
  }

  if (lat1 === lat2 && lon1 === lon2) {
    return 0
  }

  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const radLat1 = toRad(lat1)
  const radLat2 = toRad(lat2)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)

  // Clamp 'a' to [0, 1] to prevent NaN due to floating-point rounding
  const clampedA = Math.min(1, Math.max(0, a))
  const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA))

  return EARTH_RADIUS_METERS * c
}

export const haversine = haversineDistance

/**
 * Compute total cumulative distance along an array of GPS points in meters.
 * Skips invalid points. Returns 0 for empty or single-point arrays.
 */
export function totalDistance(points) {
  if (!Array.isArray(points) || points.length < 2) return 0

  let sum = 0
  let prev = null

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!isValidPoint(p)) continue
    if (prev != null) {
      sum += haversineDistance(prev, p)
    }
    prev = p
  }

  return sum
}

export const computeTotalDistance = totalDistance

// ---------------------------------------------------------------------------
// 2. Moving Time & Speed Filtering
// ---------------------------------------------------------------------------

/**
 * Calculate speed in m/s between two points based on distance and timestamps.
 * Returns 0 if time delta is <= 0 or points are missing.
 */
export function pointSpeed(p1, p2) {
  if (!p1 || !p2) return 0
  const t1 = getPointTime(p1)
  const t2 = getPointTime(p2)
  if (t1 == null || t2 == null) return 0

  const dtSeconds = (t2 - t1) / 1000
  if (dtSeconds <= 0) return 0

  const dist = haversineDistance(p1, p2)
  return dist / dtSeconds
}

/**
 * Check if the segment between p1 and p2 exceeds the moving speed threshold.
 */
export function isMoving(p1, p2, threshold = DEFAULT_MOVING_SPEED_THRESHOLD) {
  return pointSpeed(p1, p2) >= threshold
}

/**
 * Compute total elapsed time in seconds between first and last valid timestamps.
 * Returns 0 if track has fewer than 2 valid timestamps or elapsed <= 0.
 */
export function computeElapsedTime(points) {
  if (!Array.isArray(points) || points.length < 2) return 0

  let firstTime = null
  let lastTime = null

  for (let i = 0; i < points.length; i++) {
    const t = getPointTime(points[i])
    if (t != null) {
      if (firstTime == null) firstTime = t
      lastTime = t
    }
  }

  if (firstTime == null || lastTime == null || lastTime <= firstTime) return 0
  return (lastTime - firstTime) / 1000
}

/**
 * Compute total moving time in seconds by filtering out intervals where speed < threshold.
 * Also skips pauses/gaps longer than maxGapSeconds (default: 300s).
 */
export function computeMovingTime(points, options = {}) {
  const {
    threshold = DEFAULT_MOVING_SPEED_THRESHOLD,
    maxGapSeconds = 300,
  } = options

  if (!Array.isArray(points) || points.length < 2) return 0

  let movingSec = 0
  let prev = null

  for (let i = 0; i < points.length; i++) {
    const curr = points[i]
    if (!isValidPoint(curr)) continue

    if (prev != null) {
      const t1 = getPointTime(prev)
      const t2 = getPointTime(curr)

      if (t1 != null && t2 != null) {
        const dt = (t2 - t1) / 1000
        if (dt > 0 && dt <= maxGapSeconds) {
          const dist = haversineDistance(prev, curr)
          const spd = dist / dt
          if (spd >= threshold) {
            movingSec += dt
          }
        }
      }
    }
    prev = curr
  }

  return movingSec
}

/**
 * Filter track points, returning only points where the user was moving.
 * Always keeps the first and last valid points to preserve track boundaries.
 */
export function filterMovingPoints(points, options = {}) {
  const {
    threshold = DEFAULT_MOVING_SPEED_THRESHOLD,
  } = options

  if (!Array.isArray(points)) return []
  if (points.length <= 2) return points.slice()

  const valid = points.filter(isValidPoint)
  if (valid.length <= 2) return valid

  const result = [valid[0]]

  for (let i = 1; i < valid.length - 1; i++) {
    const prev = valid[i - 1]
    const curr = valid[i]
    const next = valid[i + 1]

    const spd1 = pointSpeed(prev, curr)
    const spd2 = pointSpeed(curr, next)

    if (spd1 >= threshold || spd2 >= threshold) {
      result.push(curr)
    }
  }

  result.push(valid[valid.length - 1])
  return result
}

// ---------------------------------------------------------------------------
// 3. Rolling Pace and Rolling Speed
// ---------------------------------------------------------------------------

/**
 * Compute rolling speed (in m/s) at each point along the track.
 * Uses a time window (default: 10s) preceding each point, or a point window if timestamps are missing.
 */
export function rollingSpeed(points, options = {}) {
  const {
    windowSeconds = 10,
    windowPoints = null,
  } = typeof options === 'number' ? { windowSeconds: options } : options

  if (!Array.isArray(points)) return []
  if (points.length === 0) return []

  const n = points.length
  const speeds = new Array(n).fill(0)

  for (let i = 0; i < n; i++) {
    const curr = points[i]
    if (!isValidPoint(curr)) {
      speeds[i] = 0
      continue
    }

    const currTime = getPointTime(curr)
    let dist = 0
    let dt = 0

    if (currTime != null && (windowPoints == null || windowPoints <= 0)) {
      // Time-based sliding window preceding point i
      let j = i - 1
      let lastPoint = curr

      while (j >= 0) {
        const p = points[j]
        if (isValidPoint(p)) {
          const t = getPointTime(p)
          if (t != null) {
            const timeDiff = (currTime - t) / 1000
            dist += haversineDistance(p, lastPoint)
            dt = timeDiff
            lastPoint = p
            if (timeDiff >= windowSeconds) break
          }
        }
        j--
      }
    } else {
      // Point-count sliding window
      const count = windowPoints || 5
      let j = i - 1
      let steps = 0
      let lastPoint = curr

      while (j >= 0 && steps < count) {
        const p = points[j]
        if (isValidPoint(p)) {
          dist += haversineDistance(p, lastPoint)
          const t1 = getPointTime(p)
          const t2 = getPointTime(lastPoint)
          if (t1 != null && t2 != null) {
            dt += Math.max(0, (t2 - t1) / 1000)
          }
          lastPoint = p
          steps++
        }
        j--
      }
      if (dt <= 0 && steps > 0) {
        dt = steps // fallback nominal 1 sec per step if no timestamps
      }
    }

    speeds[i] = dt > 0 ? dist / dt : 0
  }

  return speeds
}

export const computeRollingSpeed = rollingSpeed

/**
 * Convert speed in m/s to pace.
 * Returns pace in seconds/meter by default, or minutes/km ('kg') or minutes/mi ('lbs').
 */
export function speedToPace(speedMps, unit = 'm/s') {
  if (speedMps == null || speedMps <= 0 || !Number.isFinite(speedMps)) return 0

  if (unit === 'kg' || unit === 'min/km') {
    // minutes per kilometer
    return (1000 / speedMps) / 60
  }
  if (unit === 'lbs' || unit === 'min/mi') {
    // minutes per mile
    return (METERS_PER_MILE / speedMps) / 60
  }
  // Default: seconds per meter
  return 1 / speedMps
}

/**
 * Compute rolling pace for each point along the track.
 * By default returns pace in minutes/km (or minutes/mi if unit === 'lbs').
 */
export function rollingPace(points, options = {}) {
  const opts = typeof options === 'number' ? { windowSeconds: options } : options
  const unit = opts.unit || 'kg'
  const speeds = rollingSpeed(points, opts)

  return speeds.map(spd => speedToPace(spd, unit))
}

export const computeRollingPace = rollingPace

// ---------------------------------------------------------------------------
// 4. Windowed Elevation Smoothing & Ascent/Descent
// ---------------------------------------------------------------------------

/**
 * Smooth elevation values across track points using a sliding window or low-pass filter.
 * Returns a new array of points with smoothed elevation (does not mutate original points).
 */
export function smoothElevation(points, options = {}) {
  const {
    windowSize = DEFAULT_ELEVATION_WINDOW,
    method = 'window', // 'window' (moving average) or 'ema' (exponential moving average)
    alpha = 0.25,
  } = options

  if (!Array.isArray(points)) return []
  if (points.length === 0) return []

  const n = points.length
  // Clone points to avoid mutation
  const result = points.map(p => {
    if (Array.isArray(p)) return [...p]
    return typeof p === 'object' && p !== null ? { ...p } : p
  })

  // Extract raw elevations
  const rawEle = points.map(getPointEle)

  // Identify segments with valid elevation
  const smoothedEle = new Array(n)

  if (method === 'ema') {
    let lastSmoothed = null
    for (let i = 0; i < n; i++) {
      const ele = rawEle[i]
      if (ele == null) {
        smoothedEle[i] = null
        continue
      }
      if (lastSmoothed == null) {
        lastSmoothed = ele
      } else {
        lastSmoothed = alpha * ele + (1 - alpha) * lastSmoothed
      }
      smoothedEle[i] = Math.round(lastSmoothed * 100) / 100
    }
  } else {
    // Centered sliding window moving average
    const half = Math.floor(Math.max(1, windowSize) / 2)

    for (let i = 0; i < n; i++) {
      if (rawEle[i] == null) {
        smoothedEle[i] = null
        continue
      }

      let sum = 0
      let count = 0
      const start = Math.max(0, i - half)
      const end = Math.min(n - 1, i + half)

      for (let j = start; j <= end; j++) {
        if (rawEle[j] != null) {
          sum += rawEle[j]
          count++
        }
      }

      smoothedEle[i] = count > 0 ? Math.round((sum / count) * 100) / 100 : rawEle[i]
    }
  }

  // Update elevation on cloned points
  for (let i = 0; i < n; i++) {
    const val = smoothedEle[i]
    if (val != null) {
      if (Array.isArray(result[i])) {
        result[i][2] = val
      } else if (typeof result[i] === 'object' && result[i] !== null) {
        if (result[i].ele !== undefined) result[i].ele = val
        else if (result[i].alt !== undefined) result[i].alt = val
        else if (result[i].elevation !== undefined) result[i].elevation = val
        else result[i].ele = val
      }
    }
  }

  return result
}

/**
 * Compute total cumulative elevation gain and loss in meters.
 * Options:
 *   threshold: minimum altitude difference in meters required to count toward gain/loss (filters noise).
 *   smooth: whether to apply elevation smoothing first (default: true).
 *   windowSize: window size for smoothing (default: 5).
 */
export function computeElevationGain(points, options = {}) {
  const {
    threshold = DEFAULT_ELEVATION_THRESHOLD,
    smooth = true,
    windowSize = DEFAULT_ELEVATION_WINDOW,
  } = options

  const stats = {
    gain: 0,
    loss: 0,
    min: null,
    max: null,
  }

  if (!Array.isArray(points) || points.length === 0) return stats

  const pts = (smooth && points.length >= windowSize) ? smoothElevation(points, { windowSize }) : points

  let prevEle = null

  for (let i = 0; i < pts.length; i++) {
    const ele = getPointEle(pts[i])
    if (ele == null) continue

    if (stats.min == null || ele < stats.min) stats.min = ele
    if (stats.max == null || ele > stats.max) stats.max = ele

    if (prevEle != null) {
      const diff = ele - prevEle
      if (Math.abs(diff) >= threshold) {
        if (diff > 0) {
          stats.gain += diff
        } else {
          stats.loss += Math.abs(diff)
        }
        prevEle = ele
      }
    } else {
      prevEle = ele
    }
  }

  stats.gain = Math.round(stats.gain * 10) / 10
  stats.loss = Math.round(stats.loss * 10) / 10
  if (stats.min != null) stats.min = Math.round(stats.min * 10) / 10
  if (stats.max != null) stats.max = Math.round(stats.max * 10) / 10

  return stats
}

// ---------------------------------------------------------------------------
// 5. Split Computation (Metric 1000m & Imperial 1609.344m)
// ---------------------------------------------------------------------------

/**
 * Linearly interpolate point properties between p1 and p2 at target distance ratio.
 */
function interpolatePoint(p1, p2, ratio) {
  const lat1 = getPointLat(p1)
  const lon1 = getPointLon(p1)
  const lat2 = getPointLat(p2)
  const lon2 = getPointLon(p2)

  const t1 = getPointTime(p1)
  const t2 = getPointTime(p2)

  const e1 = getPointEle(p1)
  const e2 = getPointEle(p2)

  return {
    lat: lat1 + (lat2 - lat1) * ratio,
    lon: lon1 + (lon2 - lon1) * ratio,
    ele: e1 != null && e2 != null ? e1 + (e2 - e1) * ratio : (e1 ?? e2),
    time: t1 != null && t2 != null ? Math.round(t1 + (t2 - t1) * ratio) : (t1 ?? t2),
  }
}

/**
 * Compute metric (1000m) or imperial (1609.344m) splits from GPS points.
 * Options:
 *   unit: 'kg' (metric, 1000m) or 'lbs' (imperial, 1609.344m)
 *   splitDistance: custom split distance in meters (overrides unit default)
 *   movingThreshold: threshold for moving time filtering (default: 0.5 m/s)
 */
export function computeSplits(points, options = {}) {
  const unit = options.unit || 'kg'
  const isImperial = unit === 'lbs'
  const targetSplitDist =
    options.splitDistance || (isImperial ? METERS_PER_MILE : METERS_PER_KM)
  const movingThreshold =
    options.movingThreshold ?? DEFAULT_MOVING_SPEED_THRESHOLD

  if (!Array.isArray(points) || points.length < 2) return []

  const valid = points.filter(isValidPoint)
  if (valid.length < 2) return []

  const splits = []
  let splitIndex = 1

  let cumDist = 0
  let splitStartDist = 0
  let splitStartTime = getPointTime(valid[0])
  let splitStartEle = getPointEle(valid[0])
  let splitMovingTime = 0
  let splitGain = 0
  let splitLoss = 0

  let prevPoint = valid[0]
  let prevEle = splitStartEle

  for (let i = 1; i < valid.length; i++) {
    const currPoint = valid[i]
    const segDist = haversineDistance(prevPoint, currPoint)
    if (segDist <= 0) {
      prevPoint = currPoint
      continue
    }

    const tPrev = getPointTime(prevPoint)
    const tCurr = getPointTime(currPoint)
    const dt = tPrev != null && tCurr != null ? Math.max(0, (tCurr - tPrev) / 1000) : 0
    const spd = dt > 0 ? segDist / dt : 0

    const eleCurr = getPointEle(currPoint)
    if (prevEle != null && eleCurr != null) {
      const eDiff = eleCurr - prevEle
      if (eDiff > 0) splitGain += eDiff
      else splitLoss += Math.abs(eDiff)
      prevEle = eleCurr
    } else if (eleCurr != null) {
      prevEle = eleCurr
    }

    if (spd >= movingThreshold) {
      splitMovingTime += dt
    }

    cumDist += segDist

    // Check if we reached or crossed the next split boundary
    const nextBoundary = splitIndex * targetSplitDist

    if (cumDist >= nextBoundary) {
      // Interpolate exact boundary crossing
      const overshoot = cumDist - nextBoundary
      const segmentRatio = segDist > 0 ? (segDist - overshoot) / segDist : 1
      const boundaryPoint = interpolatePoint(prevPoint, currPoint, Math.min(1, Math.max(0, segmentRatio)))

      const boundaryTime = getPointTime(boundaryPoint)
      const boundaryEle = getPointEle(boundaryPoint)

      const splitElapsedTime =
        boundaryTime != null && splitStartTime != null
          ? Math.max(0, (boundaryTime - splitStartTime) / 1000)
          : dt

      const splitDistM = targetSplitDist
      const speedMps = splitElapsedTime > 0 ? splitDistM / splitElapsedTime : 0
      const paceVal = speedToPace(speedMps, unit)

      splits.push({
        split: splitIndex,
        distance: Math.round(splitDistM * 100) / 100,
        cumulativeDistance: Math.round(nextBoundary * 100) / 100,
        elapsedTime: Math.round(splitElapsedTime * 10) / 10,
        cumulativeTime: boundaryTime != null && getPointTime(valid[0]) != null
          ? Math.round(((boundaryTime - getPointTime(valid[0])) / 1000) * 10) / 10
          : null,
        movingTime: Math.round(splitMovingTime * 10) / 10,
        pace: Math.round(paceVal * 100) / 100,
        speed: Math.round(speedMps * 100) / 100,
        elevationGain: Math.round(splitGain * 10) / 10,
        elevationLoss: Math.round(splitLoss * 10) / 10,
        isPartial: false,
      })

      // Reset for next split starting at boundary
      splitIndex++
      splitStartDist = nextBoundary
      splitStartTime = boundaryTime
      splitStartEle = boundaryEle
      prevEle = boundaryEle
      splitMovingTime = dt > 0 && spd >= movingThreshold ? dt * (overshoot / segDist) : 0
      splitGain = 0
      splitLoss = 0
    }

    prevPoint = currPoint
  }

  // Final partial split if remaining distance > 0
  const remainingDist = cumDist - splitStartDist
  if (remainingDist > 1) { // ignore trivial jitter (< 1m)
    const lastPoint = valid[valid.length - 1]
    const lastTime = getPointTime(lastPoint)
    const splitElapsedTime =
      lastTime != null && splitStartTime != null
        ? Math.max(0, (lastTime - splitStartTime) / 1000)
        : 0

    const speedMps = splitElapsedTime > 0 ? remainingDist / splitElapsedTime : 0
    const paceVal = speedToPace(speedMps, unit)

    splits.push({
      split: splitIndex,
      distance: Math.round(remainingDist * 100) / 100,
      cumulativeDistance: Math.round(cumDist * 100) / 100,
      elapsedTime: Math.round(splitElapsedTime * 10) / 10,
      cumulativeTime: lastTime != null && getPointTime(valid[0]) != null
        ? Math.round(((lastTime - getPointTime(valid[0])) / 1000) * 10) / 10
        : null,
      movingTime: Math.round(splitMovingTime * 10) / 10,
      pace: Math.round(paceVal * 100) / 100,
      speed: Math.round(speedMps * 100) / 100,
      elevationGain: Math.round(splitGain * 10) / 10,
      elevationLoss: Math.round(splitLoss * 10) / 10,
      isPartial: true,
    })
  }

  return splits
}

// ---------------------------------------------------------------------------
// 6. MET-Based Calorie Estimation
// ---------------------------------------------------------------------------

/**
 * Determine dynamic MET based on activity type and speed (in km/h).
 */
export function getActivityMet(activity = 'run', speedKmh = null) {
  const norm = (activity || 'run').toLowerCase().trim()

  if (norm.includes('run')) {
    if (speedKmh == null || speedKmh <= 0) return MET_BY_ACTIVITY.run
    if (speedKmh < 8) return 8.0
    if (speedKmh < 9.5) return 9.0
    if (speedKmh < 11) return 10.0
    if (speedKmh < 12.5) return 11.5
    if (speedKmh < 14) return 12.5
    if (speedKmh < 16) return 14.0
    return 16.0
  }

  if (norm.includes('ride') || norm.includes('bike') || norm.includes('cycle')) {
    if (speedKmh == null || speedKmh <= 0) return MET_BY_ACTIVITY.ride
    if (speedKmh < 16) return 5.5
    if (speedKmh < 20) return 6.8
    if (speedKmh < 24) return 8.0
    if (speedKmh < 28) return 10.0
    if (speedKmh < 32) return 12.0
    return 14.0
  }

  if (norm.includes('walk')) {
    if (speedKmh == null || speedKmh <= 0) return MET_BY_ACTIVITY.walk
    if (speedKmh < 4) return 2.8
    if (speedKmh < 5.5) return 3.8
    if (speedKmh < 7) return 5.0
    return 6.5
  }

  if (norm.includes('hike')) {
    return MET_BY_ACTIVITY.hike
  }

  return MET_BY_ACTIVITY[norm] || 6.0
}

/**
 * Estimate energy expenditure in kcal using the standard MET formula:
 *   Calories = MET * bodyWeightKg * (durationHours)
 *
 * Options:
 *   activity: 'run', 'ride', 'hike', 'walk'
 *   weightKg: body weight in kilograms (default: 70 kg)
 *   weightLbs: body weight in lbs (converted to kg if weightKg not provided)
 *   durationSeconds: duration in seconds (moving or elapsed)
 *   distanceMeters: total distance in meters (optional, used to derive speed)
 *   speedKmh: speed in km/h (optional)
 *   elevationGainM: elevation gain in meters (adds work adjustment for hiking)
 */
export function estimateCalories(options = {}) {
  const {
    activity = 'run',
    durationSeconds = 0,
    distanceMeters = 0,
    elevationGainM = 0,
  } = options

  if (durationSeconds <= 0) return 0

  let weightKg = options.weightKg
  if (weightKg == null && options.weightLbs != null) {
    weightKg = options.weightLbs / LBS_PER_KG
  }
  if (weightKg == null || weightKg <= 0) {
    weightKg = 70 // default fallback average adult weight (kg)
  }

  let speedKmh = options.speedKmh
  if (speedKmh == null && distanceMeters > 0 && durationSeconds > 0) {
    speedKmh = (distanceMeters / 1000) / (durationSeconds / 3600)
  }

  let met = getActivityMet(activity, speedKmh)

  // Elevation ascent adjustment (e.g. +0.1 MET per 100m elevation gain per hour)
  if (elevationGainM > 0 && durationSeconds > 0) {
    const hours = durationSeconds / 3600
    const gainPerHour = elevationGainM / hours
    met += (gainPerHour / 100) * 0.1
  }

  const durationHours = durationSeconds / 3600
  const calories = met * weightKg * durationHours

  return Math.round(calories)
}

// ---------------------------------------------------------------------------
// 7. Ramer-Douglas-Peucker (RDP) Compaction
// ---------------------------------------------------------------------------

/**
 * Calculate perpendicular distance in meters from point P to line segment AB.
 * Uses locally projected Cartesian coordinates (equirectangular projection) around mean latitude.
 */
function perpendicularDistanceMeters(p, a, b) {
  const latP = getPointLat(p)
  const lonP = getPointLon(p)
  const latA = getPointLat(a)
  const lonA = getPointLon(a)
  const latB = getPointLat(b)
  const lonB = getPointLon(b)

  if (
    latP == null || lonP == null ||
    latA == null || lonA == null ||
    latB == null || lonB == null
  ) {
    return 0
  }

  // Local mean latitude for longitude scaling
  const meanLat = toRad((latA + latB + latP) / 3)
  const cosLat = Math.cos(meanLat)

  // Meters per degree
  const metersPerDegLat = 111132.954
  const metersPerDegLon = 111412.84 * cosLat

  // Convert to local Cartesian meters relative to A
  const px = (lonP - lonA) * metersPerDegLon
  const py = (latP - latA) * metersPerDegLat
  const bx = (lonB - lonA) * metersPerDegLon
  const by = (latB - latA) * metersPerDegLat

  const lineLenSq = bx * bx + by * by

  if (lineLenSq === 0) {
    // A and B are the same location
    return Math.sqrt(px * px + py * py)
  }

  // Cross-product formula for point-line distance: |(B - A) x (P - A)| / |B - A|
  const crossProduct = Math.abs(bx * py - by * px)
  return crossProduct / Math.sqrt(lineLenSq)
}

/**
 * Ramer-Douglas-Peucker (RDP) trajectory simplification / downsampling algorithm.
 * Recursively reduces GPS track points while preserving shape within tolerance epsilon (meters).
 *
 * @param {Array} points - Array of track points
 * @param {number} epsilon - Maximum allowed perpendicular distance error in meters (default: 5m)
 * @returns {Array} Compacted array of points
 */
export function ramerDouglasPeucker(points, epsilon = DEFAULT_RDP_EPSILON) {
  if (!Array.isArray(points)) return []
  if (points.length <= 2) return points.slice()
  if (epsilon <= 0) return points.slice()

  let maxDist = 0
  let index = 0
  const first = points[0]
  const last = points[points.length - 1]

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistanceMeters(points[i], first, last)
    if (d > maxDist) {
      maxDist = d
      index = i
    }
  }

  if (maxDist > epsilon) {
    const left = ramerDouglasPeucker(points.slice(0, index + 1), epsilon)
    const right = ramerDouglasPeucker(points.slice(index), epsilon)
    return left.slice(0, left.length - 1).concat(right)
  }

  return [first, last]
}

export const rdp = ramerDouglasPeucker
export const compactTrack = ramerDouglasPeucker

// ---------------------------------------------------------------------------
// 8. Comprehensive Track Analysis
// ---------------------------------------------------------------------------

/**
 * Compute a full mathematical profile and summary of a GPS track.
 * Combines distance, moving time, pace, elevation profile, calorie expenditure,
 * splits, and compacted geometry.
 */
export function analyzeTrack(points, options = {}) {
  const {
    activity = 'run',
    weightKg = 70,
    unit = 'kg',
    movingThreshold = DEFAULT_MOVING_SPEED_THRESHOLD,
    elevationWindow = DEFAULT_ELEVATION_WINDOW,
    rdpEpsilon = DEFAULT_RDP_EPSILON,
  } = options

  if (!Array.isArray(points) || points.length === 0) {
    return {
      pointCount: 0,
      compactedCount: 0,
      totalDistance: 0,
      elapsedTime: 0,
      movingTime: 0,
      stoppedTime: 0,
      avgSpeed: 0,
      avgMovingSpeed: 0,
      maxSpeed: 0,
      avgPace: 0,
      movingPace: 0,
      elevationGain: 0,
      elevationLoss: 0,
      minElevation: null,
      maxElevation: null,
      calories: 0,
      splits: [],
    }
  }

  const valid = points.filter(isValidPoint)
  const distM = totalDistance(valid)
  const elapsedSec = computeElapsedTime(valid)
  const movingSec = computeMovingTime(valid, { threshold: movingThreshold })
  const stoppedSec = Math.max(0, elapsedSec - movingSec)

  const speeds = rollingSpeed(valid, { windowSeconds: 5 })
  const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 0

  const eleStats = computeElevationGain(valid, { windowSize: elevationWindow })

  const avgSpeed = elapsedSec > 0 ? distM / elapsedSec : 0
  const avgMovingSpeed = movingSec > 0 ? distM / movingSec : 0

  const calories = estimateCalories({
    activity,
    weightKg,
    durationSeconds: movingSec > 0 ? movingSec : elapsedSec,
    distanceMeters: distM,
    elevationGainM: eleStats.gain,
  })

  const splits = computeSplits(valid, { unit, movingThreshold })
  const compacted = rdp(valid, rdpEpsilon)

  return {
    pointCount: points.length,
    validPointCount: valid.length,
    compactedCount: compacted.length,
    totalDistance: Math.round(distM * 10) / 10,
    elapsedTime: Math.round(elapsedSec * 10) / 10,
    movingTime: Math.round(movingSec * 10) / 10,
    stoppedTime: Math.round(stoppedSec * 10) / 10,
    avgSpeed: Math.round(avgSpeed * 100) / 100,
    avgMovingSpeed: Math.round(avgMovingSpeed * 100) / 100,
    maxSpeed: Math.round(maxSpeed * 100) / 100,
    avgPace: Math.round(speedToPace(avgSpeed, unit) * 100) / 100,
    movingPace: Math.round(speedToPace(avgMovingSpeed, unit) * 100) / 100,
    elevationGain: eleStats.gain,
    elevationLoss: eleStats.loss,
    minElevation: eleStats.min,
    maxElevation: eleStats.max,
    calories,
    splits,
  }
}
