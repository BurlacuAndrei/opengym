// Best Efforts and Personal Records calculation engine (Issue #55).
// Pure functions for sliding-window interval search across standard distances and durations.

import {
  haversineDistance,
  isValidPoint,
  getPointTime,
} from './track-math.js'

// Standard distance targets in meters:
// 400m, 1k, 1mi, 5k, 10k, half-marathon, marathon
export const STANDARD_DISTANCE_TARGETS = Object.freeze([
  400,
  1000,
  1609.344,
  5000,
  10000,
  21097.5,
  42195,
])

// Standard duration targets in seconds:
// 1m (60s), 5m (300s), 12m (720s), 20m (1200s), 1h (3600s)
export const STANDARD_DURATION_TARGETS = Object.freeze([
  60,
  300,
  720,
  1200,
  3600,
])

// Human-readable canonical labels for standard targets
export const DISTANCE_LABELS = Object.freeze({
  400: '400m',
  1000: '1k',
  1609.344: '1mi',
  5000: '5k',
  10000: '10k',
  21097.5: 'half-marathon',
  42195: 'marathon',
})

export const DURATION_LABELS = Object.freeze({
  60: '1m',
  300: '5m',
  720: '12m',
  1200: '20m',
  3600: '1h',
})

// Alias lookup for string targets
const DISTANCE_ALIAS_MAP = {
  '400': 400,
  '400m': 400,
  '1000': 1000,
  '1k': 1000,
  '1km': 1000,
  '1000m': 1000,
  '1609.344': 1609.344,
  '1mi': 1609.344,
  '1mile': 1609.344,
  'mile': 1609.344,
  '5000': 5000,
  '5k': 5000,
  '5km': 5000,
  '5000m': 5000,
  '10000': 10000,
  '10k': 10000,
  '10km': 10000,
  '10000m': 10000,
  '21097.5': 21097.5,
  'half': 21097.5,
  'half-marathon': 21097.5,
  'half_marathon': 21097.5,
  'halfmarathon': 21097.5,
  '21.1k': 21097.5,
  '42195': 42195,
  'marathon': 42195,
  'full-marathon': 42195,
  'full_marathon': 42195,
  '42.2k': 42195,
}

const DURATION_ALIAS_MAP = {
  '60': 60,
  '1m': 60,
  '1min': 60,
  '60s': 60,
  '300': 300,
  '5m': 300,
  '5min': 300,
  '300s': 300,
  '720': 720,
  '12m': 720,
  '12min': 720,
  '720s': 720,
  'cooper': 720,
  '1200': 1200,
  '20m': 1200,
  '20min': 1200,
  '1200s': 1200,
  'ftp': 1200,
  '3600': 3600,
  '1h': 3600,
  '1hr': 3600,
  '60m': 3600,
  '3600s': 3600,
}

/**
 * Returns canonical label for a distance in meters.
 */
export function getDistanceLabel(meters) {
  if (meters == null || isNaN(meters)) return ''
  const m = Number(meters)
  if (DISTANCE_LABELS[m]) return DISTANCE_LABELS[m]
  for (const [distStr, lbl] of Object.entries(DISTANCE_LABELS)) {
    if (Math.abs(Number(distStr) - m) < 0.01) return lbl
  }
  if (m < 1000) return `${Math.round(m)}m`
  const km = m / 1000
  return Number.isInteger(km) ? `${km}k` : `${parseFloat(km.toFixed(2))}k`
}

/**
 * Returns canonical label for a duration in seconds.
 */
export function getDurationLabel(seconds) {
  if (seconds == null || isNaN(seconds)) return ''
  const s = Math.round(Number(seconds))
  if (DURATION_LABELS[s]) return DURATION_LABELS[s]
  if (s < 60) return `${s}s`
  if (s < 3600) {
    const mins = s / 60
    return Number.isInteger(mins) ? `${mins}m` : `${parseFloat(mins.toFixed(1))}m`
  }
  const hrs = s / 3600
  return Number.isInteger(hrs) ? `${hrs}h` : `${parseFloat(hrs.toFixed(1))}h`
}

/**
 * Parse distance target specification to number (meters).
 */
export function parseDistanceTarget(val) {
  if (typeof val === 'number') return val > 0 ? val : null
  if (typeof val === 'string') {
    const key = val.trim().toLowerCase()
    if (DISTANCE_ALIAS_MAP[key] != null) return DISTANCE_ALIAS_MAP[key]
    const num = parseFloat(key)
    if (!isNaN(num) && num > 0) return num
  }
  return null
}

/**
 * Parse duration target specification to number (seconds).
 */
export function parseDurationTarget(val) {
  if (typeof val === 'number') return val > 0 ? val : null
  if (typeof val === 'string') {
    const key = val.trim().toLowerCase()
    if (DURATION_ALIAS_MAP[key] != null) return DURATION_ALIAS_MAP[key]
    const num = parseFloat(key)
    if (!isNaN(num) && num > 0) return num
  }
  return null
}

/**
 * Normalize raw track points into a standardized sequence with cumulative distance
 * (meters) and elapsed time (seconds) starting strictly at 0.
 */
function extractTrackSamples(points) {
  if (!Array.isArray(points) || points.length < 2) return []

  const rawSamples = []
  let cumDist = 0
  let t0 = null
  let prevPoint = null
  let prevRawTime = null
  let cumTimeSec = 0
  let isRelativeTime = false

  // Detect if timestamps look like relative seconds (< 10,000,000)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p == null) continue
    if (typeof p.elapsedTime === 'number' || typeof p.elapsedSec === 'number') {
      isRelativeTime = true
      break
    }
    const raw = getPointTime(p)
    if (raw != null && raw > 0 && raw < 10000000) {
      isRelativeTime = true
      break
    }
  }

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p == null) continue

    // Resolve timestamp
    let rawTime = null
    if (typeof p.elapsedTime === 'number') rawTime = p.elapsedTime
    else if (typeof p.elapsedSec === 'number') rawTime = p.elapsedSec
    else if (typeof p.cumulativeTime === 'number') rawTime = p.cumulativeTime
    else {
      const ptTime = getPointTime(p)
      if (ptTime != null) {
        rawTime = isRelativeTime ? ptTime : ptTime / 1000
      } else if (typeof p.time === 'number') {
        rawTime = p.time >= 1e9 ? p.time / 1000 : p.time
      } else if (typeof p.t === 'number') {
        rawTime = p.t >= 1e9 ? p.t / 1000 : p.t
      }
    }

    // Resolve distance
    let explicitCumDist = null
    if (typeof p.cumulativeDistance === 'number') explicitCumDist = p.cumulativeDistance
    else if (typeof p.cumDist === 'number') explicitCumDist = p.cumDist

    if (explicitCumDist != null) {
      cumDist = Math.max(cumDist, explicitCumDist)
    } else if (prevPoint != null) {
      if (isValidPoint(p) && isValidPoint(prevPoint)) {
        const seg = haversineDistance(prevPoint, p)
        if (seg > 0) cumDist += seg
      } else if (typeof p.distance === 'number') {
        if (p.distance >= cumDist) cumDist = p.distance
        else if (p.distance > 0) cumDist += p.distance
      } else if (typeof p.d === 'number') {
        if (p.d >= cumDist) cumDist = p.d
        else if (p.d > 0) cumDist += p.d
      }
    } else if (typeof p.distance === 'number' && p.distance > 0) {
      cumDist = p.distance
    } else if (typeof p.d === 'number' && p.d > 0) {
      cumDist = p.d
    }

    if (rawTime != null) {
      if (t0 == null) {
        t0 = rawTime
        cumTimeSec = 0
      } else {
        const dt = rawTime - (prevRawTime ?? t0)
        cumTimeSec += Math.max(0, dt)
      }
      prevRawTime = rawTime
    } else {
      if (rawSamples.length > 0) cumTimeSec += 1
    }

    rawSamples.push({
      index: i,
      d: cumDist,
      t: cumTimeSec,
      rawTime: rawTime != null ? (isRelativeTime ? rawTime : rawTime * 1000) : null,
      point: p,
    })

    prevPoint = p
  }

  if (rawSamples.length < 2) return []

  // Ensure origin is zero-based: samples[0].d === 0, samples[0].t === 0
  const d0 = rawSamples[0].d
  const t0Sec = rawSamples[0].t
  const samples = []
  let lastD = 0
  let lastT = 0

  for (let i = 0; i < rawSamples.length; i++) {
    const s = rawSamples[i]
    const d = Math.max(lastD, Math.max(0, s.d - d0))
    const t = Math.max(lastT, Math.max(0, s.t - t0Sec))
    lastD = d
    lastT = t
    samples.push({
      index: s.index,
      d,
      t,
      rawTime: s.rawTime,
      point: s.point,
    })
  }

  return samples
}

/**
 * Calculate best effort for a specific distance target using linear interpolation.
 */
function findBestDistanceEffort(samples, targetDist) {
  const n = samples.length
  if (n < 2) return null
  const totalDist = samples[n - 1].d
  const EPSILON = 0.05 // 5cm tolerance for GPS spherical precision
  if (totalDist < targetDist - EPSILON) return null

  let minTime = Infinity
  let bestWindow = null

  // Case A: Window start aligned to sample[i]
  let right = 0
  for (let i = 0; i < n; i++) {
    const startD = samples[i].d
    const endD = Math.min(totalDist, startD + targetDist)
    if (startD + targetDist > totalDist + EPSILON) break

    while (right < n && samples[right].d < endD) {
      right++
    }
    if (right >= n) break

    const rPrev = samples[right - 1]
    const rCurr = samples[right]
    const segDist = rCurr.d - rPrev.d
    const f = segDist > 0 ? (endD - rPrev.d) / segDist : 0
    const endT = rPrev.t + f * (rCurr.t - rPrev.t)
    const elapsed = Math.max(0, endT - samples[i].t)

    if (elapsed < minTime) {
      minTime = elapsed
      bestWindow = {
        elapsedTime: elapsed,
        startIndex: samples[i].index,
        endIndex: rCurr.index,
        startSec: samples[i].t,
        endSec: endT,
        startTime: samples[i].rawTime,
        endTime: rPrev.rawTime != null && rCurr.rawTime != null
          ? rPrev.rawTime + f * (rCurr.rawTime - rPrev.rawTime)
          : null,
      }
    }
  }

  // Case B: Window end aligned to sample[j]
  let left = 0
  for (let j = 1; j < n; j++) {
    const endD = samples[j].d
    if (endD < targetDist - EPSILON) continue
    const startD = Math.max(0, endD - targetDist)

    while (left + 1 < j && samples[left + 1].d <= startD) {
      left++
    }

    const lCurr = samples[left]
    const lNext = samples[left + 1]
    const segDist = lNext.d - lCurr.d
    const f = segDist > 0 ? (startD - lCurr.d) / segDist : 0
    const startT = lCurr.t + f * (lNext.t - lCurr.t)
    const elapsed = Math.max(0, samples[j].t - startT)

    if (elapsed < minTime) {
      minTime = elapsed
      bestWindow = {
        elapsedTime: elapsed,
        startIndex: lCurr.index,
        endIndex: samples[j].index,
        startSec: startT,
        endSec: samples[j].t,
        startTime: lCurr.rawTime != null && lNext.rawTime != null
          ? lCurr.rawTime + f * (lNext.rawTime - lCurr.rawTime)
          : null,
        endTime: samples[j].rawTime,
      }
    }
  }

  if (bestWindow == null || !Number.isFinite(minTime)) return null

  const label = getDistanceLabel(targetDist)
  const speed = minTime > 0 ? targetDist / minTime : 0
  const pace = targetDist > 0 ? minTime / (targetDist / 1000) : 0

  return {
    type: 'distance',
    target: targetDist,
    targetDistance: targetDist,
    distance: targetDist,
    elapsedTime: minTime,
    duration: minTime,
    time: minTime,
    speed,
    pace,
    startIndex: bestWindow.startIndex,
    endIndex: bestWindow.endIndex,
    startSec: bestWindow.startSec,
    endSec: bestWindow.endSec,
    startTime: bestWindow.startTime,
    endTime: bestWindow.endTime,
    label,
    name: label,
  }
}

/**
 * Calculate best effort for a specific duration target using linear interpolation.
 */
function findBestDurationEffort(samples, targetDurationSec) {
  const n = samples.length
  if (n < 2) return null
  const totalDuration = samples[n - 1].t
  const TIME_EPSILON = 0.05 // 50ms tolerance
  if (totalDuration < targetDurationSec - TIME_EPSILON) return null

  let maxDist = -1
  let bestWindow = null

  // Case A: Window start aligned to sample[i]
  let right = 0
  for (let i = 0; i < n; i++) {
    const startT = samples[i].t
    const endT = Math.min(totalDuration, startT + targetDurationSec)
    if (startT + targetDurationSec > totalDuration + TIME_EPSILON) break

    while (right < n && samples[right].t < endT) {
      right++
    }
    if (right >= n) break

    const rPrev = samples[right - 1]
    const rCurr = samples[right]
    const segT = rCurr.t - rPrev.t
    const f = segT > 0 ? (endT - rPrev.t) / segT : 0
    const endD = rPrev.d + f * (rCurr.d - rPrev.d)
    const distGained = Math.max(0, endD - samples[i].d)

    if (distGained > maxDist) {
      maxDist = distGained
      bestWindow = {
        distance: distGained,
        startIndex: samples[i].index,
        endIndex: rCurr.index,
        startSec: samples[i].t,
        endSec: endT,
        startTime: samples[i].rawTime,
        endTime: rPrev.rawTime != null && rCurr.rawTime != null
          ? rPrev.rawTime + f * (rCurr.rawTime - rPrev.rawTime)
          : null,
      }
    }
  }

  // Case B: Window end aligned to sample[j]
  let left = 0
  for (let j = 1; j < n; j++) {
    const endT = samples[j].t
    if (endT < targetDurationSec - TIME_EPSILON) continue
    const startT = Math.max(0, endT - targetDurationSec)

    while (left + 1 < j && samples[left + 1].t <= startT) {
      left++
    }

    const lCurr = samples[left]
    const lNext = samples[left + 1]
    const segT = lNext.t - lCurr.t
    const f = segT > 0 ? (startT - lCurr.t) / segT : 0
    const startD = lCurr.d + f * (lNext.d - lCurr.d)
    const distGained = Math.max(0, samples[j].d - startD)

    if (distGained > maxDist) {
      maxDist = distGained
      bestWindow = {
        distance: distGained,
        startIndex: lCurr.index,
        endIndex: samples[j].index,
        startSec: startT,
        endSec: samples[j].t,
        startTime: lCurr.rawTime != null && lNext.rawTime != null
          ? lCurr.rawTime + f * (lNext.rawTime - lCurr.rawTime)
          : null,
        endTime: samples[j].rawTime,
      }
    }
  }

  if (bestWindow == null || maxDist < 0) return null

  const label = getDurationLabel(targetDurationSec)
  const speed = targetDurationSec > 0 ? maxDist / targetDurationSec : 0
  const pace = maxDist > 0 ? targetDurationSec / (maxDist / 1000) : null

  return {
    type: 'duration',
    target: targetDurationSec,
    targetDuration: targetDurationSec,
    duration: targetDurationSec,
    elapsedTime: targetDurationSec,
    time: targetDurationSec,
    distance: maxDist,
    speed,
    pace,
    startIndex: bestWindow.startIndex,
    endIndex: bestWindow.endIndex,
    startSec: bestWindow.startSec,
    endSec: bestWindow.endSec,
    startTime: bestWindow.startTime,
    endTime: bestWindow.endTime,
    label,
    name: label,
  }
}

/**
 * Attach non-enumerable helper properties to an effort result array.
 */
function attachResultProperties(arr, distances, durations, byTarget) {
  Object.defineProperties(arr, {
    distances: { value: distances, enumerable: false, writable: true, configurable: true },
    durations: { value: durations, enumerable: false, writable: true, configurable: true },
    byTarget: { value: byTarget, enumerable: false, writable: true, configurable: true },
    isEmpty: { value: arr.length === 0, enumerable: false, writable: true, configurable: true },
  })

  for (const [key, val] of Object.entries(byTarget)) {
    if (!(key in arr)) {
      Object.defineProperty(arr, key, {
        value: val,
        enumerable: false,
        writable: true,
        configurable: true,
      })
    }
  }

  return arr
}

/**
 * Calculate Best Efforts across standard (or custom) distance and duration targets.
 *
 * @param {Array} trackPoints - Array of GPS track points
 * @param {Object|Array} [standardTargets] - Optional custom target configuration
 * @returns {Array} List of achieved efforts, with .distances, .durations, and key index accessors
 */
export function calculateBestEfforts(trackPoints, standardTargets = null) {
  if (!Array.isArray(trackPoints) || trackPoints.length < 2) {
    return attachResultProperties([], [], [], {})
  }

  // Parse target options
  let distTargets = STANDARD_DISTANCE_TARGETS
  let durTargets = STANDARD_DURATION_TARGETS

  if (standardTargets != null) {
    if (Array.isArray(standardTargets)) {
      distTargets = standardTargets.map(parseDistanceTarget).filter(Boolean)
      durTargets = []
    } else if (typeof standardTargets === 'object') {
      if (standardTargets.distances != null) {
        distTargets = Array.isArray(standardTargets.distances)
          ? standardTargets.distances.map(parseDistanceTarget).filter(Boolean)
          : []
      }
      if (standardTargets.durations != null) {
        durTargets = Array.isArray(standardTargets.durations)
          ? standardTargets.durations.map(parseDurationTarget).filter(Boolean)
          : []
      }
    }
  }

  const samples = extractTrackSamples(trackPoints)
  if (samples.length < 2) {
    return attachResultProperties([], [], [], {})
  }

  const distanceEfforts = []
  for (const d of distTargets) {
    const effort = findBestDistanceEffort(samples, d)
    if (effort) distanceEfforts.push(effort)
  }

  const durationEfforts = []
  for (const t of durTargets) {
    const effort = findBestDurationEffort(samples, t)
    if (effort) durationEfforts.push(effort)
  }

  const allEfforts = [...distanceEfforts, ...durationEfforts]
  const byTarget = {}

  for (const effort of allEfforts) {
    if (effort.label) byTarget[effort.label] = effort
    if (effort.name) byTarget[effort.name] = effort
    if (effort.target != null) {
      byTarget[String(effort.target)] = effort
      byTarget[effort.target] = effort
    }
  }

  return attachResultProperties(allEfforts, distanceEfforts, durationEfforts, byTarget)
}

/**
 * Standardize an effort or record into a canonical label key.
 */
function canonicalRecordKey(item) {
  if (item == null) return null
  if (item.type === 'duration' || item.targetDuration != null) {
    const dur = parseDurationTarget(item.target ?? item.targetDuration ?? item.label ?? item.name)
    if (dur != null) return getDurationLabel(dur)
  }
  if (item.type === 'distance' || item.targetDistance != null) {
    const dist = parseDistanceTarget(item.target ?? item.targetDistance ?? item.label ?? item.name)
    if (dist != null) return getDistanceLabel(dist)
  }
  const dist = parseDistanceTarget(item.target ?? item.label ?? item.name)
  if (dist != null) return getDistanceLabel(dist)
  const dur = parseDurationTarget(item.target ?? item.label ?? item.name)
  if (dur != null) return getDurationLabel(dur)
  return item.label || item.name || (item.target != null ? String(item.target) : null)
}

/**
 * Determine if a candidate effort beats an existing personal record.
 */
function isBetterEffort(candidate, existing) {
  if (!existing) return true
  if (candidate.type === 'duration') {
    const cDist = Number(candidate.distance)
    const eDist = Number(existing.distance)
    if (isNaN(cDist)) return false
    if (isNaN(eDist)) return true
    return cDist > eDist
  }
  const cTime = Number(candidate.elapsedTime ?? candidate.duration ?? candidate.time)
  const eTime = Number(existing.elapsedTime ?? existing.duration ?? existing.time)
  if (isNaN(cTime)) return false
  if (isNaN(eTime)) return true
  return cTime < eTime
}

/**
 * Update personal records with new activity efforts. Pure function.
 *
 * @param {Object|Array} existingRecords - Current personal records
 * @param {Object|Array} activityEfforts - Best efforts from new activity
 * @returns {Object|Array} Updated personal records with .newRecords and metadata
 */
export function updatePersonalRecords(existingRecords = {}, activityEfforts = []) {
  const recordsMap = {}

  // 1. Ingest existing records without mutating
  const ingestExisting = (rec, fallbackKey = null) => {
    if (rec == null || typeof rec !== 'object') return
    const key = canonicalRecordKey(rec) || (fallbackKey ? canonicalRecordKey({ label: fallbackKey }) || fallbackKey : null)
    if (key) {
      recordsMap[key] = { ...rec, isNewPr: false, isNewRecord: false }
    }
  }

  if (Array.isArray(existingRecords)) {
    for (const rec of existingRecords) ingestExisting(rec)
  } else if (existingRecords && typeof existingRecords === 'object') {
    if (Array.isArray(existingRecords.records)) {
      for (const rec of existingRecords.records) ingestExisting(rec)
    } else {
      const source = existingRecords.records || existingRecords
      for (const [k, val] of Object.entries(source)) {
        if (
          k === 'distances' ||
          k === 'durations' ||
          k === 'newRecords' ||
          k === 'newPrs' ||
          k === 'byTarget' ||
          k === 'records'
        ) {
          continue
        }
        if (val && typeof val === 'object' && (val.elapsedTime != null || val.distance != null || val.target != null)) {
          ingestExisting(val, k)
        }
      }
      if (existingRecords.distances && typeof existingRecords.distances === 'object') {
        for (const [k, val] of Object.entries(existingRecords.distances)) {
          if (val && typeof val === 'object') ingestExisting(val, k)
        }
      }
      if (existingRecords.durations && typeof existingRecords.durations === 'object') {
        for (const [k, val] of Object.entries(existingRecords.durations)) {
          if (val && typeof val === 'object') ingestExisting(val, k)
        }
      }
    }
  }

  // 2. Ingest new efforts
  const effortList = Array.isArray(activityEfforts)
    ? activityEfforts
    : [
        ...(Array.isArray(activityEfforts?.distances) ? activityEfforts.distances : []),
        ...(Array.isArray(activityEfforts?.durations) ? activityEfforts.durations : []),
        ...(activityEfforts && typeof activityEfforts === 'object'
          ? Object.entries(activityEfforts)
              .filter(([k]) => !['distances', 'durations', 'newRecords', 'newPrs', 'byTarget', 'records'].includes(k))
              .map(([k, v]) => (v && typeof v === 'object' ? { ...v, label: v.label || k } : null))
              .filter(Boolean)
          : []),
      ]

  const newRecordsList = []

  for (const effort of effortList) {
    if (effort == null || typeof effort !== 'object') continue
    const key = canonicalRecordKey(effort)
    if (!key) continue

    const existing = recordsMap[key]
    if (isBetterEffort(effort, existing)) {
      const updatedRecord = {
        ...effort,
        label: key,
        name: key,
        isNewPr: true,
        isNewRecord: true,
        previousRecord: existing ? { ...existing } : null,
      }
      recordsMap[key] = updatedRecord
      newRecordsList.push(updatedRecord)
    }
  }

  // 3. Assemble partitioned results
  const distanceMap = {}
  const durationMap = {}
  const allList = []

  // Preserve canonical ordering for standard distances
  for (const d of STANDARD_DISTANCE_TARGETS) {
    const lbl = DISTANCE_LABELS[d]
    if (recordsMap[lbl]) {
      distanceMap[lbl] = recordsMap[lbl]
      distanceMap[d] = recordsMap[lbl]
      if (!allList.includes(recordsMap[lbl])) allList.push(recordsMap[lbl])
    }
  }
  // Any non-standard distance records
  for (const [k, rec] of Object.entries(recordsMap)) {
    if (rec.type === 'distance' && !allList.includes(rec)) {
      distanceMap[k] = rec
      allList.push(rec)
    }
  }

  // Preserve canonical ordering for standard durations
  for (const t of STANDARD_DURATION_TARGETS) {
    const lbl = DURATION_LABELS[t]
    if (recordsMap[lbl]) {
      durationMap[lbl] = recordsMap[lbl]
      durationMap[t] = recordsMap[lbl]
      if (!allList.includes(recordsMap[lbl])) allList.push(recordsMap[lbl])
    }
  }
  // Any non-standard duration records
  for (const [k, rec] of Object.entries(recordsMap)) {
    if (rec.type === 'duration' && !allList.includes(rec)) {
      durationMap[k] = rec
      allList.push(rec)
    }
  }

  // Remaining records
  for (const rec of Object.values(recordsMap)) {
    if (!allList.includes(rec)) allList.push(rec)
  }

  // Map numeric and string aliases in recordsMap
  for (const rec of allList) {
    if (rec.target != null) {
      recordsMap[String(rec.target)] = rec
      recordsMap[rec.target] = rec
    }
    if (rec.label) {
      recordsMap[rec.label] = rec
    }
  }

  const meta = {
    records: recordsMap,
    distances: distanceMap,
    durations: durationMap,
    newRecords: newRecordsList,
    newPrs: newRecordsList,
    hasNewRecords: newRecordsList.length > 0,
    hasNewPr: newRecordsList.length > 0,
    toArray() {
      return [...allList]
    },
    [Symbol.iterator]: function* () {
      yield* allList
    },
  }

  if (Array.isArray(existingRecords)) {
    return Object.assign([...allList], meta, recordsMap)
  }

  return Object.assign({ ...recordsMap }, meta)
}
