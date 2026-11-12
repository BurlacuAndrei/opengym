import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  RETENTION_PERIODS,
  DEFAULT_RETENTION,
  DEFAULT_RETENTION_PERIOD,
  RETENTION_LABELS,
  isValidRetentionPeriod,
  normalizeRetentionSetting,
  calculateRetentionCutoff,
  getRetentionCutoff,
  getRetentionCutoffDate,
  getActivityDate,
  isActivityExpired,
  isTrackExpired,
  pruneExpiredTracks,
} from './track-retention.js'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
} from './cardio-adapter.js'

describe('GPS Track Retention & Cleanup Policy (Issue #75)', () => {
  describe('Retention constants and settings validation', () => {
    it('defines expected retention periods: never, 1y, 2y, 5y', () => {
      expect(RETENTION_PERIODS).toEqual(['never', '1y', '2y', '5y'])
      expect(DEFAULT_RETENTION).toBe('never')
      expect(DEFAULT_RETENTION_PERIOD).toBe('never')
    })

    it('provides human-readable retention labels', () => {
      expect(RETENTION_LABELS.never).toBe('Never')
      expect(RETENTION_LABELS['1y']).toBe('1 Year')
      expect(RETENTION_LABELS['2y']).toBe('2 Years')
      expect(RETENTION_LABELS['5y']).toBe('5 Years')
    })

    it('validates allowed retention period values', () => {
      expect(isValidRetentionPeriod('never')).toBe(true)
      expect(isValidRetentionPeriod('1y')).toBe(true)
      expect(isValidRetentionPeriod('2y')).toBe(true)
      expect(isValidRetentionPeriod('5y')).toBe(true)
      expect(isValidRetentionPeriod(' 1y ')).toBe(true)

      expect(isValidRetentionPeriod('3y')).toBe(false)
      expect(isValidRetentionPeriod('6m')).toBe(false)
      expect(isValidRetentionPeriod('forever')).toBe(false)
      expect(isValidRetentionPeriod('')).toBe(false)
      expect(isValidRetentionPeriod(null)).toBe(false)
      expect(isValidRetentionPeriod(undefined)).toBe(false)
      expect(isValidRetentionPeriod(123)).toBe(false)
    })

    it('normalizes retention setting inputs gracefully', () => {
      expect(normalizeRetentionSetting('1y')).toBe('1y')
      expect(normalizeRetentionSetting('1 year')).toBe('1y')
      expect(normalizeRetentionSetting('1-year')).toBe('1y')
      expect(normalizeRetentionSetting('2y')).toBe('2y')
      expect(normalizeRetentionSetting('2 years')).toBe('2y')
      expect(normalizeRetentionSetting('5y')).toBe('5y')
      expect(normalizeRetentionSetting('5 years')).toBe('5y')
      expect(normalizeRetentionSetting('never')).toBe('never')
      expect(normalizeRetentionSetting('NEVER')).toBe('never')
      expect(normalizeRetentionSetting('invalid')).toBe('never')
      expect(normalizeRetentionSetting(null)).toBe('never')
      expect(normalizeRetentionSetting(undefined)).toBe('never')
    })
  })

  describe('Cutoff threshold calculations', () => {
    const fixedNow = new Date('2026-11-12T12:00:00Z')

    it('returns null for never setting (safety check)', () => {
      expect(calculateRetentionCutoff('never', fixedNow)).toBeNull()
      expect(getRetentionCutoff('never', fixedNow)).toBeNull()
      expect(getRetentionCutoffDate('never', fixedNow)).toBeNull()
      expect(calculateRetentionCutoff('unknown-setting', fixedNow)).toBeNull()
    })

    it('calculates exact 1-year cutoff', () => {
      const cutoff = calculateRetentionCutoff('1y', fixedNow)
      expect(cutoff).toBeInstanceOf(Date)
      expect(cutoff.toISOString()).toBe('2025-11-12T12:00:00.000Z')
    })

    it('calculates exact 2-year cutoff', () => {
      const cutoff = calculateRetentionCutoff('2y', fixedNow)
      expect(cutoff).toBeInstanceOf(Date)
      expect(cutoff.toISOString()).toBe('2024-11-12T12:00:00.000Z')
    })

    it('calculates exact 5-year cutoff', () => {
      const cutoff = calculateRetentionCutoff('5y', fixedNow)
      expect(cutoff).toBeInstanceOf(Date)
      expect(cutoff.toISOString()).toBe('2021-11-12T12:00:00.000Z')
    })

    it('accepts string dates and numeric timestamps as reference date', () => {
      const cutoffFromIso = calculateRetentionCutoff('1y', '2026-06-01T00:00:00Z')
      expect(cutoffFromIso.toISOString()).toBe('2025-06-01T00:00:00.000Z')

      const cutoffFromMs = calculateRetentionCutoff('2y', fixedNow.getTime())
      expect(cutoffFromMs.toISOString()).toBe('2024-11-12T12:00:00.000Z')
    })

    it('handles leap year reference date correctly', () => {
      const leapDay = new Date('2024-02-29T12:00:00Z')
      const cutoff1y = calculateRetentionCutoff('1y', leapDay)
      expect(cutoff1y).toBeInstanceOf(Date)
      // 2023 is not leap year, rolls to March 1
      expect(cutoff1y.getUTCFullYear()).toBe(2023)
    })

    it('returns null if reference date is invalid', () => {
      expect(calculateRetentionCutoff('1y', 'invalid-date')).toBeNull()
    })
  })

  describe('Activity date extraction and expiry checks', () => {
    const now = new Date('2026-11-12T00:00:00Z')

    it('extracts date from various activity date formats', () => {
      expect(getActivityDate({ startTime: '2026-05-01T10:00:00Z' })?.toISOString()).toBe('2026-05-01T10:00:00.000Z')
      expect(getActivityDate({ d: '2026-05-01' })?.toISOString().slice(0, 10)).toBe('2026-05-01')
      expect(getActivityDate({ date: '2026-05-01T00:00:00Z' })?.toISOString()).toBe('2026-05-01T00:00:00.000Z')
      expect(getActivityDate({ timestamp: 1700000000000 })?.getTime()).toBe(1700000000000)
      expect(getActivityDate('2026-01-01T00:00:00Z')?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
      expect(getActivityDate(null)).toBeNull()
      expect(getActivityDate({})).toBeNull()
    })

    it('never expires any activity when retention is never', () => {
      const oldActivity = { startTime: '2010-01-01T00:00:00Z' }
      expect(isActivityExpired(oldActivity, 'never', now)).toBe(false)
      expect(isTrackExpired(oldActivity, 'never', now)).toBe(false)
      expect(isActivityExpired(oldActivity, 'invalid', now)).toBe(false)
    })

    it('identifies expired activities according to threshold', () => {
      const act2025 = { startTime: '2025-06-01T00:00:00Z' }
      const act2024 = { startTime: '2024-06-01T00:00:00Z' }
      const act2020 = { startTime: '2020-01-01T00:00:00Z' }

      // 1-year retention (cutoff: 2025-11-12)
      expect(isActivityExpired(act2025, '1y', now)).toBe(true)
      expect(isActivityExpired(act2024, '1y', now)).toBe(true)

      // Recent activity within 1 year (2026-05-01)
      const recentAct = { startTime: '2026-05-01T00:00:00Z' }
      expect(isActivityExpired(recentAct, '1y', now)).toBe(false)

      // 2-year retention (cutoff: 2024-11-12)
      expect(isActivityExpired(act2025, '2y', now)).toBe(false)
      expect(isActivityExpired(act2024, '2y', now)).toBe(true)
      expect(isActivityExpired(act2020, '2y', now)).toBe(true)

      // 5-year retention (cutoff: 2021-11-12)
      expect(isActivityExpired(act2024, '5y', now)).toBe(false)
      expect(isActivityExpired(act2020, '5y', now)).toBe(true)
    })
  })

  describe('pruneExpiredTracks cleanup sweep', () => {
    let memoryAdapter
    const refNow = new Date('2026-11-12T12:00:00Z')

    beforeEach(() => {
      memoryAdapter = createMemoryCardioAdapter({
        tracks: {
          '2024/old-act.json': { id: 'old-act', points: [{ latitude: 45, longitude: 9 }] },
          '2026/recent-act.json': { id: 'recent-act', points: [{ latitude: 45, longitude: 9 }] },
          '2020/ancient-act.json': { id: 'ancient-act', points: [{ latitude: 45, longitude: 9 }] },
        },
      })
      setCardioAdapter(memoryAdapter)
    })

    it('safety check: never setting deletes zero files and modifies zero activities', async () => {
      const activities = [
        {
          id: 'old-act',
          startTime: '2024-01-01T00:00:00Z',
          trackPath: '2024/old-act.json',
          distanceM: 5000,
          durationMs: 1800000,
        },
        {
          id: 'recent-act',
          startTime: '2026-10-01T00:00:00Z',
          trackPath: '2026/recent-act.json',
          distanceM: 10000,
          durationMs: 3600000,
        },
      ]

      const result = await pruneExpiredTracks(activities, 'never', memoryAdapter, { now: refNow })

      expect(result.prunedCount).toBe(0)
      expect(result.deletedCount).toBe(0)
      expect(result.deletedFiles).toEqual([])
      expect(await memoryAdapter.hasTrack('2024/old-act.json')).toBe(true)
      expect(await memoryAdapter.hasTrack('2026/recent-act.json')).toBe(true)
      expect(activities[0].trackPruned).toBeUndefined()
      expect(activities[1].trackPruned).toBeUndefined()
    })

    it('prunes tracks older than 1 year, preserving summary metrics', async () => {
      const activities = [
        {
          id: 'old-act',
          type: 'run',
          startTime: '2024-01-01T00:00:00Z',
          trackPath: '2024/old-act.json',
          distanceM: 5200,
          durationMs: 1840000,
          elevationGainM: 120,
          avgPaceSecKm: 353.8,
          avgSpeedKmh: 10.17,
          calories: 380,
          notes: 'Great old run',
          gearId: 'Pegasus 39',
          points: [{ lat: 45, lon: 9 }],
        },
        {
          id: 'recent-act',
          type: 'run',
          startTime: '2026-10-01T00:00:00Z',
          trackPath: '2026/recent-act.json',
          distanceM: 10000,
          durationMs: 3600000,
          elevationGainM: 200,
          avgPaceSecKm: 360,
          avgSpeedKmh: 10,
          calories: 700,
          notes: 'Recent tempo run',
          gearId: 'Pegasus 40',
        },
      ]

      const result = await pruneExpiredTracks(activities, '1y', memoryAdapter, { now: refNow })

      // Expired track file was deleted from adapter
      expect(await memoryAdapter.hasTrack('2024/old-act.json')).toBe(false)
      // Recent track file was preserved
      expect(await memoryAdapter.hasTrack('2026/recent-act.json')).toBe(true)

      // Check stats
      expect(result.prunedCount).toBe(1)
      expect(result.deletedFiles).toContain('2024/old-act.json')

      // Expired activity has trackPruned: true
      const oldAct = result.find(a => a.id === 'old-act')
      expect(oldAct.trackPruned).toBe(true)
      expect(oldAct.points).toBeUndefined()

      // Summary metrics are preserved exactly
      expect(oldAct.distanceM).toBe(5200)
      expect(oldAct.durationMs).toBe(1840000)
      expect(oldAct.elevationGainM).toBe(120)
      expect(oldAct.avgPaceSecKm).toBe(353.8)
      expect(oldAct.avgSpeedKmh).toBe(10.17)
      expect(oldAct.calories).toBe(380)
      expect(oldAct.notes).toBe('Great old run')
      expect(oldAct.gearId).toBe('Pegasus 39')

      // Recent activity was NOT marked trackPruned
      const recentAct = result.find(a => a.id === 'recent-act')
      expect(recentAct.trackPruned).toBeUndefined()
    })

    it('calls adapter.deleteTrack for each expired track', async () => {
      const mockAdapter = {
        deleteTrack: vi.fn().mockResolvedValue(true),
      }

      const activities = [
        {
          id: 'act-1',
          startTime: '2020-01-01T00:00:00Z',
          trackPath: '2020/act-1.json',
        },
        {
          id: 'act-2',
          startTime: '2021-01-01T00:00:00Z',
          trackPath: '2021/act-2.json',
        },
        {
          id: 'act-3',
          startTime: '2026-01-01T00:00:00Z',
          trackPath: '2026/act-3.json',
        },
      ]

      const result = await pruneExpiredTracks(activities, '2y', mockAdapter, refNow)

      expect(mockAdapter.deleteTrack).toHaveBeenCalledTimes(2)
      expect(mockAdapter.deleteTrack).toHaveBeenCalledWith('2020/act-1.json')
      expect(mockAdapter.deleteTrack).toHaveBeenCalledWith('2021/act-2.json')
      expect(mockAdapter.deleteTrack).not.toHaveBeenCalledWith('2026/act-3.json')
      expect(result.prunedCount).toBe(2)
    })

    it('skips activities that are already trackPruned: true', async () => {
      const mockAdapter = {
        deleteTrack: vi.fn().mockResolvedValue(true),
      }

      const activities = [
        {
          id: 'already-pruned',
          startTime: '2020-01-01T00:00:00Z',
          trackPath: '2020/already-pruned.json',
          trackPruned: true,
        },
      ]

      const result = await pruneExpiredTracks(activities, '1y', mockAdapter, refNow)

      expect(mockAdapter.deleteTrack).not.toHaveBeenCalled()
      expect(result.prunedCount).toBe(0)
    })

    it('resolves track file path when trackPath is omitted but id & startTime exist', async () => {
      const mockAdapter = {
        deleteTrack: vi.fn().mockResolvedValue(true),
      }

      const activities = [
        {
          id: 'auto-resolve-1',
          startTime: '2020-05-01T00:00:00Z',
          distanceM: 3000,
        },
      ]

      const result = await pruneExpiredTracks(activities, '1y', mockAdapter, refNow)

      expect(mockAdapter.deleteTrack).toHaveBeenCalledWith('2020/auto-resolve-1.json')
      expect(result.prunedCount).toBe(1)
      expect(result[0].trackPruned).toBe(true)
    })

    it('handles adapter deletion failure gracefully without throwing', async () => {
      const failingAdapter = {
        deleteTrack: vi.fn().mockRejectedValue(new Error('Storage access failed')),
      }

      const activities = [
        {
          id: 'error-act',
          startTime: '2020-01-01T00:00:00Z',
          trackPath: '2020/error-act.json',
          distanceM: 4000,
        },
      ]

      const result = await pruneExpiredTracks(activities, '1y', failingAdapter, refNow)

      expect(result.prunedCount).toBe(1)
      expect(result[0].trackPruned).toBe(true)
      expect(result[0].distanceM).toBe(4000)
    })

    it('supports array destructuring and object destructuring of result', async () => {
      const activities = [
        {
          id: 'act-a',
          startTime: '2020-01-01T00:00:00Z',
          trackPath: '2020/act-a.json',
        },
      ]

      const result = await pruneExpiredTracks(activities, '1y', memoryAdapter, refNow)

      // Array behavior
      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(1)
      expect(result[0].id).toBe('act-a')

      // Destructuring activities and stats
      const { activities: resActs, prunedCount, deletedFiles } = result
      expect(resActs).toBe(result)
      expect(prunedCount).toBe(1)
      expect(deletedFiles).toContain('2020/act-a.json')
    })

    it('handles empty, null, or undefined activities safely', async () => {
      expect((await pruneExpiredTracks([], '1y')).prunedCount).toBe(0)
      expect((await pruneExpiredTracks(null, '1y')).prunedCount).toBe(0)
      expect((await pruneExpiredTracks(undefined, '1y')).prunedCount).toBe(0)
    })
  })
})
