/**
 * GPS Track Retention & Cleanup Policy (Issue #75)
 *
 * Implements configurable retention periods for raw GPS track files:
 *   - 'never' (default: keep indefinitely)
 *   - '1y'    (prune tracks older than 1 year)
 *   - '2y'    (prune tracks older than 2 years)
 *   - '5y'    (prune tracks older than 5 years)
 *
 * When expired tracks are pruned:
 *   - Track data files are removed via the cardio storage adapter
 *   - The activity summary is preserved (distance, duration, pace, elevation, calories, notes, gear)
 *   - The activity is flagged with `trackPruned: true`
 */

import { getCardioAdapter } from './cardio-adapter.js'
import { resolveTrackPath, deleteTrackFile } from './track-trim.js'

export const RETENTION_PERIODS = Object.freeze(['never', '1y', '2y', '5y'])
export const DEFAULT_RETENTION = 'never'
export const DEFAULT_RETENTION_PERIOD = 'never'

export const RETENTION_LABELS = Object.freeze({
  never: 'Never',
  '1y': '1 Year',
  '2y': '2 Years',
  '5y': '5 Years',
})

/**
 * Checks if a retention period setting string is valid.
 *
 * @param {string} period
 * @returns {boolean}
 */
export function isValidRetentionPeriod(period) {
  if (typeof period !== 'string') return false
  const norm = period.trim().toLowerCase()
  return RETENTION_PERIODS.includes(norm)
}

/**
 * Normalizes retention setting to one of the canonical period strings.
 * Falls back to 'never' for unknown or invalid inputs.
 *
 * @param {string} setting
 * @returns {string} 'never' | '1y' | '2y' | '5y'
 */
export function normalizeRetentionSetting(setting) {
  if (!setting || typeof setting !== 'string') return DEFAULT_RETENTION
  const norm = setting.trim().toLowerCase()
  if (norm === '1y' || norm === '1 year' || norm === '1-year' || norm === '1_year') return '1y'
  if (norm === '2y' || norm === '2 years' || norm === '2-year' || norm === '2_year') return '2y'
  if (norm === '5y' || norm === '5 years' || norm === '5-year' || norm === '5_year') return '5y'
  if (norm === 'never') return 'never'
  return DEFAULT_RETENTION
}

/**
 * Calculates the cutoff Date based on retention setting and reference date.
 * Returns null if retention is 'never' or invalid.
 *
 * @param {string} retentionSetting - 'never' | '1y' | '2y' | '5y'
 * @param {Date|string|number} [now=new Date()] - Reference date
 * @returns {Date|null} Cutoff date or null if retention is 'never'
 */
export function calculateRetentionCutoff(retentionSetting, now = new Date()) {
  const norm = normalizeRetentionSetting(retentionSetting)
  if (norm === 'never') return null

  const refDate = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  if (isNaN(refDate.getTime())) return null

  let years = 0
  if (norm === '1y') years = 1
  else if (norm === '2y') years = 2
  else if (norm === '5y') years = 5
  else return null

  const cutoff = new Date(refDate.getTime())
  cutoff.setFullYear(cutoff.getFullYear() - years)
  return cutoff
}

// Aliases for convenience
export const getRetentionCutoff = calculateRetentionCutoff
export const getRetentionCutoffDate = calculateRetentionCutoff

/**
 * Extracts a valid Date object from an activity or date-like representation.
 *
 * @param {Object|string|number|Date} activityOrDate
 * @returns {Date|null}
 */
export function getActivityDate(activityOrDate) {
  if (!activityOrDate) return null
  if (activityOrDate instanceof Date) {
    return isNaN(activityOrDate.getTime()) ? null : activityOrDate
  }
  if (typeof activityOrDate === 'number') {
    const d = new Date(activityOrDate)
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof activityOrDate === 'string') {
    const d = new Date(activityOrDate)
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof activityOrDate === 'object') {
    const raw =
      activityOrDate.startTime ||
      activityOrDate.d ||
      activityOrDate.date ||
      activityOrDate.timestamp ||
      activityOrDate.createdAt ||
      activityOrDate.time
    if (raw) {
      const d = new Date(raw)
      return isNaN(d.getTime()) ? null : d
    }
  }
  return null
}

/**
 * Checks whether an activity or track is expired based on retention setting.
 * Always returns false for 'never'.
 *
 * @param {Object|string|number|Date} activityOrDate
 * @param {string} retentionSetting
 * @param {Date|string|number} [now=new Date()]
 * @returns {boolean}
 */
export function isActivityExpired(activityOrDate, retentionSetting, now = new Date()) {
  const cutoff = calculateRetentionCutoff(retentionSetting, now)
  if (!cutoff) return false

  const date = getActivityDate(activityOrDate)
  if (!date) return false

  return date.getTime() < cutoff.getTime()
}

export const isTrackExpired = isActivityExpired

/**
 * Executes a cleanup sweep of expired GPS tracks.
 * Finds activities older than the retention cutoff, deletes their track files
 * via the cardio adapter, and flags the activity with `trackPruned: true`,
 * while preserving all summary metrics (distance, duration, pace, elevation, calories, etc.).
 *
 * @param {Array<Object>} activities - Array of cardio activities
 * @param {string} [retentionSetting='never'] - Retention period ('never', '1y', '2y', '5y')
 * @param {Object} [adapter=null] - Cardio adapter with deleteTrack method
 * @param {Object|Date|number|string} [options={}] - Options or reference date
 * @returns {Promise<Array<Object>>} Pruned activities array with attached stats
 */
export async function pruneExpiredTracks(
  activities,
  retentionSetting = DEFAULT_RETENTION,
  adapter = null,
  options = {}
) {
  // Support flexible argument positions: if adapter is an options object / Date
  let targetAdapter = adapter
  let opts = options

  if (
    targetAdapter &&
    typeof targetAdapter === 'object' &&
    typeof targetAdapter.deleteTrack !== 'function' &&
    (targetAdapter.now || targetAdapter instanceof Date || typeof targetAdapter.now === 'string')
  ) {
    opts = targetAdapter
    targetAdapter = null
  }

  const resolvedAdapter = targetAdapter || getCardioAdapter()
  const refDate =
    opts instanceof Date || typeof opts === 'number' || typeof opts === 'string'
      ? opts
      : opts?.now || new Date()

  const safeActivities = Array.isArray(activities) ? activities : []
  const normSetting = normalizeRetentionSetting(retentionSetting)
  const cutoff = calculateRetentionCutoff(normSetting, refDate)

  let prunedCount = 0
  let deletedCount = 0
  const deletedFiles = []

  // Safety check: 'never' or invalid -> never prune anything
  if (!cutoff) {
    const result = [...safeActivities]
    result.activities = result
    result.prunedCount = 0
    result.deletedCount = 0
    result.deletedFiles = []
    result.cutoffDate = null
    result.retentionSetting = normSetting
    return result
  }

  const cutoffTime = cutoff.getTime()
  const resultList = []

  for (const activity of safeActivities) {
    if (!activity || typeof activity !== 'object') {
      resultList.push(activity)
      continue
    }

    // If activity has already been pruned, keep it as is
    if (activity.trackPruned) {
      resultList.push(activity)
      continue
    }

    const actDate = getActivityDate(activity)
    const isExpired = actDate && actDate.getTime() < cutoffTime

    if (!isExpired) {
      resultList.push(activity)
      continue
    }

    // Expired activity! Find and delete track file
    const trackPath = activity.trackPath || activity.path || resolveTrackPath(activity)

    if (trackPath && resolvedAdapter && typeof resolvedAdapter.deleteTrack === 'function') {
      try {
        const deleted = await resolvedAdapter.deleteTrack(trackPath)
        if (deleted) {
          deletedCount++
        }
        deletedFiles.push(trackPath)
      } catch (err) {
        console.warn(`Failed to delete track file at ${trackPath}:`, err)
      }
    } else if (trackPath) {
      try {
        const deleted = await deleteTrackFile(trackPath, resolvedAdapter)
        if (deleted) {
          deletedCount++
        }
        deletedFiles.push(trackPath)
      } catch (err) {
        console.warn(`Failed to delete track file via deleteTrackFile:`, err)
      }
    }

    // Flag activity as trackPruned: true, preserving summary metrics
    let targetActivity = activity
    if (Object.isFrozen(activity)) {
      targetActivity = { ...activity }
    }
    targetActivity.trackPruned = true
    if ('points' in targetActivity) {
      delete targetActivity.points
    }

    prunedCount++
    resultList.push(targetActivity)
  }

  resultList.activities = resultList
  resultList.prunedCount = prunedCount
  resultList.deletedCount = deletedCount
  resultList.deletedFiles = deletedFiles
  resultList.cutoffDate = cutoff
  resultList.retentionSetting = normSetting

  return resultList
}
