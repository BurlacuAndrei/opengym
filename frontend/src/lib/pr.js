// Personal Records (PR) detection, ranking, and formatting engine (Issue #66).
// Pure functions for cardio PR trophy badges (Rank 1 Gold, Rank 2 Silver, Rank 3 Bronze)
// and personal records management across standard distances.

import {
  STANDARD_DISTANCE_TARGETS,
  DISTANCE_LABELS,
  calculateBestEfforts,
  updatePersonalRecords,
  getDistanceLabel,
  parseDistanceTarget,
} from './best-efforts.js'
import {
  paceFromSeconds,
  fmtPace,
  isImperial,
} from './cardio-format.js'

/**
 * Standard distance targets for Personal Records in meters:
 * 1k (1000m), 1mi (1609.344m), 5k (5000m), 10k (10000m), half marathon (21097.5m), marathon (42195m).
 */
export const STANDARD_PR_DISTANCES = Object.freeze([
  1000,
  1609.344,
  5000,
  10000,
  21097.5,
  42195,
])

/**
 * Canonical labels for standard PR distances.
 */
export const STANDARD_PR_LABELS = Object.freeze({
  1000: '1k',
  1609.344: '1mi',
  5000: '5k',
  10000: '10k',
  21097.5: 'half-marathon',
  42195: 'marathon',
})

/**
 * Human-friendly display titles for standard PR distances.
 */
export const STANDARD_PR_DISPLAY_NAMES = Object.freeze({
  '1k': '1k',
  '1mi': '1 mi',
  '5k': '5k',
  '10k': '10k',
  'half-marathon': 'Half Marathon',
  'marathon': 'Marathon',
})

/**
 * PR Rank metadata (Rank 1 = Gold PR, Rank 2 = Silver, Rank 3 = Bronze).
 */
export const PR_RANKS = Object.freeze({
  1: Object.freeze({
    rank: 1,
    name: 'gold',
    label: 'PR',
    shortLabel: '1st',
    title: 'Personal Record',
    color: 'var(--yellow, #ffd60a)',
    bg: 'color-mix(in srgb, var(--yellow, #ffd60a) 18%, transparent)',
    icon: 'trophy',
  }),
  2: Object.freeze({
    rank: 2,
    name: 'silver',
    label: '2nd',
    shortLabel: '2nd',
    title: '2nd Best Effort',
    color: '#d1d5db',
    bg: 'color-mix(in srgb, #d1d5db 20%, transparent)',
    icon: 'trophy',
  }),
  3: Object.freeze({
    rank: 3,
    name: 'bronze',
    label: '3rd',
    shortLabel: '3rd',
    title: '3rd Best Effort',
    color: '#cd7f32',
    bg: 'color-mix(in srgb, #cd7f32 20%, transparent)',
    icon: 'trophy',
  }),
})

/**
 * Returns rank metadata for a given rank (1, 2, or 3).
 *
 * @param {number} rank - Rank number (1, 2, 3)
 * @returns {Object|null}
 */
export function getRankMeta(rank) {
  return PR_RANKS[rank] || null
}

/**
 * Format duration in seconds to "m:ss" or "h:mm:ss".
 *
 * @param {number} seconds - Total elapsed seconds
 * @returns {string} Formatted time string
 */
export function formatPrTime(seconds) {
  if (seconds == null || isNaN(Number(seconds)) || Number(seconds) <= 0 || !isFinite(Number(seconds))) {
    return '—'
  }
  const totalSec = Math.round(Number(seconds))
  const hrs = Math.floor(totalSec / 3600)
  const remSec = totalSec % 3600
  const mins = Math.floor(remSec / 60)
  const secs = remSec % 60

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/**
 * Format average pace for a PR effort.
 *
 * @param {number} elapsedTimeSec - Elapsed time in seconds
 * @param {number} distanceMeters - Distance in meters
 * @param {string} unit - 'kg' (metric, min/km) or 'lbs' (imperial, min/mi)
 * @returns {string} Formatted pace string (e.g. "4:15 /km" or "6:50 /mi")
 */
export function formatPrPace(elapsedTimeSec, distanceMeters, unit = 'kg') {
  if (!elapsedTimeSec || !distanceMeters || elapsedTimeSec <= 0 || distanceMeters <= 0) {
    return '—'
  }
  const paceVal = paceFromSeconds(elapsedTimeSec, distanceMeters, unit)
  if (!paceVal) return '—'
  return fmtPace(paceVal, unit, { short: true })
}

/**
 * Extracts GPS track points from an activity object.
 *
 * @param {Object} activity - Activity object
 * @returns {Array} Array of track points
 */
export function extractTrackPoints(activity) {
  if (!activity || typeof activity !== 'object') return []
  if (Array.isArray(activity.points)) return activity.points
  if (activity.track && Array.isArray(activity.track.points)) return activity.track.points
  if (Array.isArray(activity.trackPoints)) return activity.trackPoints
  if (Array.isArray(activity.track)) return activity.track
  return []
}

/**
 * Computes or retrieves best efforts for an activity across standard targets.
 *
 * @param {Object} activity - Activity object
 * @param {Array<number>} [targets] - Standard distance targets
 * @returns {Array<Object>} List of effort objects
 */
export function getActivityEfforts(activity, targets = STANDARD_PR_DISTANCES) {
  if (!activity || typeof activity !== 'object') return []

  // 1. If best efforts are pre-computed on activity
  if (Array.isArray(activity.bestEfforts) && activity.bestEfforts.length > 0) {
    return activity.bestEfforts
  }
  if (Array.isArray(activity.efforts) && activity.efforts.length > 0) {
    return activity.efforts
  }

  // 2. If track points are available, compute using best-efforts sliding window
  const points = extractTrackPoints(activity)
  if (points.length >= 2) {
    const computed = calculateBestEfforts(points, { distances: targets, durations: [] })
    if (computed && computed.distances && computed.distances.length > 0) {
      return computed.distances
    }
  }

  // 3. Fallback for manual activities without GPS track points
  const distanceM = Number(activity.distanceM)
  const durationMs = Number(activity.durationMs)
  if (distanceM > 0 && durationMs > 0) {
    const efforts = []
    const totalSec = durationMs / 1000
    for (const target of targets) {
      if (distanceM >= target) {
        // Average speed effort for distance <= total distance
        const elapsedTime = (target / distanceM) * totalSec
        const label = STANDARD_PR_LABELS[target] || getDistanceLabel(target) || `${target}m`
        efforts.push({
          type: 'distance',
          target,
          distance: target,
          elapsedTime,
          label,
          name: label,
          activityId: activity.id,
          startTime: activity.startTime || activity.d,
          d: activity.d || (activity.startTime ? String(activity.startTime).slice(0, 10) : null),
        })
      }
    }
    return efforts
  }

  return []
}

/**
 * Pure function to calculate Personal Records (Rank 1, 2, 3) from a list of cardio activities.
 *
 * @param {Array<Object>} activities - List of cardio activities
 * @param {Object} [existingRecords] - Optional baseline records
 * @returns {Object} { records, top3, byTarget }
 */
export function computePersonalRecords(activities = [], existingRecords = {}) {
  const safeActivities = Array.isArray(activities) ? activities : []

  // Collect all efforts across all activities grouped by target key
  const effortsByTarget = {}

  // Initialize targets
  for (const d of STANDARD_PR_DISTANCES) {
    const key = STANDARD_PR_LABELS[d] || getDistanceLabel(d)
    effortsByTarget[key] = []
  }

  // Ingest existing records if provided
  if (existingRecords && typeof existingRecords === 'object') {
    const source = existingRecords.records || existingRecords
    for (const [k, rec] of Object.entries(source)) {
      if (['distances', 'durations', 'newRecords', 'newPrs', 'byTarget', 'records'].includes(k)) continue
      if (rec && typeof rec === 'object' && rec.elapsedTime != null) {
        const canonicalKey = STANDARD_PR_LABELS[rec.target] || getDistanceLabel(rec.target) || rec.label || k
        if (!effortsByTarget[canonicalKey]) effortsByTarget[canonicalKey] = []
        effortsByTarget[canonicalKey].push({ ...rec, label: canonicalKey })
      }
    }
  }

  // Sort activities chronologically to evaluate progression
  const sortedActivities = [...safeActivities].sort((a, b) => {
    const ta = new Date(a.startTime || a.d || 0).getTime()
    const tb = new Date(b.startTime || b.d || 0).getTime()
    return ta - tb
  })

  for (const act of sortedActivities) {
    const efforts = getActivityEfforts(act)
    for (const eff of efforts) {
      const key = STANDARD_PR_LABELS[eff.target] || getDistanceLabel(eff.target) || eff.label
      if (!key) continue
      if (!effortsByTarget[key]) effortsByTarget[key] = []
      effortsByTarget[key].push({
        ...eff,
        label: key,
        activityId: act.id,
        startTime: act.startTime || act.d,
        d: act.d || (act.startTime ? String(act.startTime).slice(0, 10) : null),
      })
    }
  }

  // Sort efforts for each target by elapsed time ascending (fastest first)
  const top3 = {}
  const records = {}

  for (const [key, list] of Object.entries(effortsByTarget)) {
    const sorted = [...list].sort((a, b) => Number(a.elapsedTime) - Number(b.elapsedTime))
    top3[key] = sorted.slice(0, 3).map((item, idx) => ({
      ...item,
      rank: idx + 1,
      rankMeta: PR_RANKS[idx + 1] || null,
    }))
    if (sorted.length > 0) {
      records[key] = {
        ...sorted[0],
        rank: 1,
        rankMeta: PR_RANKS[1],
      }
    }
  }

  return {
    records,
    top3,
    byTarget: records,
  }
}

/**
 * Detect PR achievements for a specific cardio activity against historical activities or profile records.
 * Tags new records with PR badge (rank 1 = gold PR, 2 = silver, 3 = bronze).
 *
 * @param {Object} activity - The activity to evaluate
 * @param {Array<Object>|Object} historyOrRecords - All cardio activities or profile records
 * @param {Object} [options] - Options (e.g. chronological: true)
 * @returns {Array<Object>} List of achieved PR achievements with rank, rankName, target, label, etc.
 */
export function detectActivityPRs(activity, historyOrRecords = [], options = {}) {
  if (!activity || typeof activity !== 'object') {
    return attachPrListMeta([])
  }

  const efforts = getActivityEfforts(activity)
  if (!efforts || efforts.length === 0) {
    return attachPrListMeta([])
  }

  const chronological = options.chronological !== false
  const actTime = new Date(activity.startTime || activity.d || 0).getTime()

  // Collect historical activities
  let historicalActivities = []
  let baselineRecords = {}

  if (Array.isArray(historyOrRecords)) {
    historicalActivities = historyOrRecords.filter(a => {
      if (a.id && activity.id && a.id === activity.id) return false
      if (chronological && actTime > 0) {
        const t = new Date(a.startTime || a.d || 0).getTime()
        return t <= actTime
      }
      return true
    })
  } else if (historyOrRecords && typeof historyOrRecords === 'object') {
    baselineRecords = historyOrRecords
  }

  // Compute baseline records and top3 prior to this activity
  const prior = computePersonalRecords(historicalActivities, baselineRecords)

  const prs = []

  for (const effort of efforts) {
    const key = STANDARD_PR_LABELS[effort.target] || getDistanceLabel(effort.target) || effort.label
    if (!key) continue

    const effortTime = Number(effort.elapsedTime)
    if (!effortTime || effortTime <= 0 || !isFinite(effortTime)) continue

    const priorTop = prior.top3[key] || []

    // Determine rank in podium (1, 2, or 3)
    let rank = null
    if (priorTop.length === 0) {
      // First effort ever recorded for this distance
      rank = 1
    } else if (effortTime < Number(priorTop[0].elapsedTime)) {
      // Faster than current #1 record
      rank = 1
    } else if (priorTop.length < 2 || effortTime < Number(priorTop[1].elapsedTime)) {
      // Faster than #2 (or only 1 prior record existed)
      rank = 2
    } else if (priorTop.length < 3 || effortTime < Number(priorTop[2].elapsedTime)) {
      // Faster than #3 (or only 2 prior records existed)
      rank = 3
    }

    if (rank !== null && rank <= 3) {
      const meta = PR_RANKS[rank]
      prs.push({
        rank,
        rankName: meta.name,
        rankLabel: meta.label,
        target: effort.target,
        label: key,
        displayName: STANDARD_PR_DISPLAY_NAMES[key] || key,
        elapsedTime: effortTime,
        distance: effort.distance || effort.target,
        activityId: activity.id,
        date: activity.d || (activity.startTime ? String(activity.startTime).slice(0, 10) : null),
        effort,
        meta,
      })
    }
  }

  // Sort PRs by standard distance target ascending
  prs.sort((a, b) => Number(a.target) - Number(b.target))

  return attachPrListMeta(prs)
}

/**
 * Attaches convenience helpers to a PR list.
 */
function attachPrListMeta(prs) {
  const hasPr = prs.some(p => p.rank === 1)
  const hasPodium = prs.length > 0
  const bestRank = prs.reduce((min, p) => (p.rank < min ? p.rank : min), 999)

  Object.defineProperties(prs, {
    hasPr: { value: hasPr, writable: true, configurable: true, enumerable: false },
    hasPodium: { value: hasPodium, writable: true, configurable: true, enumerable: false },
    bestRank: { value: bestRank === 999 ? null : bestRank, writable: true, configurable: true, enumerable: false },
    goldCount: { value: prs.filter(p => p.rank === 1).length, writable: true, configurable: true, enumerable: false },
    silverCount: { value: prs.filter(p => p.rank === 2).length, writable: true, configurable: true, enumerable: false },
    bronzeCount: { value: prs.filter(p => p.rank === 3).length, writable: true, configurable: true, enumerable: false },
  })

  return prs
}

/**
 * Tag an activity object with detected PR badges. Pure function.
 *
 * @param {Object} activity - The activity to tag
 * @param {Array<Object>|Object} historyOrRecords - History or profile records
 * @returns {Object} Cloned activity with .prs and .prSummary attached
 */
export function tagActivityWithPRs(activity, historyOrRecords = []) {
  if (!activity || typeof activity !== 'object') return activity
  const prs = detectActivityPRs(activity, historyOrRecords)
  return {
    ...activity,
    prs,
    hasPr: prs.hasPr,
    bestPrRank: prs.bestRank,
  }
}
