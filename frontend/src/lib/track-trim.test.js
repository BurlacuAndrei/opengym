import { describe, it, expect, beforeEach } from 'vitest'
import {
  trimTrack,
  deleteTrackFile,
  resolveTrackPath,
  canTrimTrack,
} from './track-trim.js'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
} from './cardio-adapter.js'
import { EARTH_RADIUS_METERS } from './track-math.js'

describe('GPS Track Trimming & Track Cleanup (Issue #65)', () => {
  // Helper to generate a realistic linear GPS track
  // 1 degree latitude ~ 111,139 meters => 1 meter ~ 1 / 111139 degrees
  function createSampleTrack(pointCount = 10, speedMps = 5, startElevation = 100) {
    const t0 = 1700000000000
    const points = []
    const metersPerDegree = (2 * Math.PI * EARTH_RADIUS_METERS) / 360

    for (let i = 0; i < pointCount; i++) {
      const distanceM = i * speedMps // 1 point per second at speedMps
      const lat = 45.0 + distanceM / metersPerDegree
      const lon = 9.0
      const ele = startElevation + i * 2 // gains 2m per point
      const time = t0 + i * 1000

      points.push({
        latitude: lat,
        longitude: lon,
        altitude: ele,
        timestamp: time,
      })
    }

    return {
      id: 'activity-run-001',
      type: 'run',
      unit: 'kg',
      startTime: new Date(t0).toISOString(),
      endTime: new Date(t0 + (pointCount - 1) * 1000).toISOString(),
      points,
      splits: [],
      summary: {
        distanceM: 0,
        elevationGainM: 0,
      },
    }
  }

  describe('trimTrack - standard trimming', () => {
    it('trims the start of a track and recalculates metrics', () => {
      const track = createSampleTrack(10, 5, 100) // 10 points (0..9)
      const trimmed = trimTrack(track, 3, 9)

      expect(trimmed.points).toHaveLength(7)
      expect(trimmed.points[0]).toBe(track.points[3])
      expect(trimmed.points[6]).toBe(track.points[9])

      // Distance should be ~30m (6 intervals * 5m/interval)
      expect(trimmed.distance).toBeGreaterThan(28)
      expect(trimmed.distance).toBeLessThan(32)
      expect(trimmed.distanceM).toBe(trimmed.distance)
      expect(trimmed.totalDistance).toBe(trimmed.distance)

      // Duration should be 6 seconds
      expect(trimmed.duration).toBe(6)
      expect(trimmed.durationMs).toBe(6000)

      // Start & end time updated
      expect(trimmed.startTime).toBe(new Date(track.points[3].timestamp).toISOString())
      expect(trimmed.endTime).toBe(new Date(track.points[9].timestamp).toISOString())

      // Elevation gain should be recalculated (> 0) and match track-math gain
      expect(trimmed.elevationGain).toBeGreaterThan(0)
      expect(trimmed.elevation).toBe(trimmed.elevationGain)

      // Pace should be recalculated and finite
      expect(trimmed.pace).toBeGreaterThan(0)
      expect(trimmed.avgPace).toBe(trimmed.pace)

      // Preserves original track identity & type
      expect(trimmed.id).toBe('activity-run-001')
      expect(trimmed.type).toBe('run')

      // Summary is populated
      expect(trimmed.summary.pointCount).toBe(7)
      expect(trimmed.summary.distanceM).toBe(trimmed.distance)
      expect(trimmed.summary.elevationGainM).toBe(trimmed.elevationGain)
    })

    it('trims the end of a track and recalculates metrics', () => {
      const track = createSampleTrack(10, 5, 100) // 10 points (0..9)
      const trimmed = trimTrack(track, 0, 4)

      expect(trimmed.points).toHaveLength(5)
      expect(trimmed.points[0]).toBe(track.points[0])
      expect(trimmed.points[4]).toBe(track.points[4])

      // 4 intervals * 5m = 20m
      expect(trimmed.distance).toBeGreaterThan(18)
      expect(trimmed.distance).toBeLessThan(22)
      expect(trimmed.duration).toBe(4)
      expect(trimmed.elevationGain).toBeGreaterThan(0)
      expect(trimmed.endTime).toBe(new Date(track.points[4].timestamp).toISOString())
    })

    it('trims both start and end simultaneously', () => {
      const track = createSampleTrack(20, 10, 50)
      const trimmed = trimTrack(track, 5, 15)

      expect(trimmed.points).toHaveLength(11) // 15 - 5 + 1
      expect(trimmed.points[0]).toBe(track.points[5])
      expect(trimmed.points[10]).toBe(track.points[15])
      expect(trimmed.duration).toBe(10)
    })

    it('recalculates kilometer splits accurately when track exceeds 1km', () => {
      // 300 points, each 10 meters apart = 3000m = 3km
      const t0 = 1700000000000
      const points = []
      const metersPerDegree = (2 * Math.PI * EARTH_RADIUS_METERS) / 360

      for (let i = 0; i < 300; i++) {
        points.push({
          latitude: 45.0 + (i * 10) / metersPerDegree,
          longitude: 9.0,
          altitude: 100,
          timestamp: t0 + i * 2000, // 5 m/s
        })
      }

      const track = {
        id: 'long-run-3k',
        type: 'run',
        points,
      }

      // Trim away the first kilometer (indices 0..99)
      // Remaining: indices 100..299 (200 points * 10m = 2000m = 2km)
      const trimmed = trimTrack(track, 100, 299)

      expect(trimmed.points).toHaveLength(200)
      expect(trimmed.splits).toBeDefined()
      // Should have 2 splits for ~2000m
      expect(trimmed.splits.length).toBeGreaterThanOrEqual(2)
      expect(trimmed.splits[0].splitIndex).toBe(1)
    })

    it('works directly on raw array of points', () => {
      const track = createSampleTrack(10, 5, 100)
      const rawPoints = track.points

      const trimmed = trimTrack(rawPoints, 2, 6)

      expect(trimmed.points).toHaveLength(5)
      expect(trimmed.points[0]).toBe(rawPoints[2])
      expect(trimmed.points[4]).toBe(rawPoints[6])
      expect(trimmed.duration).toBe(4)
      expect(trimmed.distance).toBeGreaterThan(0)
      expect(trimmed.elevation).toBeGreaterThan(0)
      expect(trimmed.elevation).toBe(trimmed.elevationGain)

      // Supports array-like access and iteration
      expect(trimmed.length).toBe(5)
      expect(trimmed[0]).toBe(rawPoints[2])
      expect([...trimmed]).toHaveLength(5)
    })

    it('supports custom options (unit imperial lbs)', () => {
      const track = createSampleTrack(10, 5, 100)
      const trimmed = trimTrack(track, 0, 9, { unit: 'lbs' })

      expect(trimmed.summary).toBeDefined()
      expect(trimmed.pace).toBeGreaterThan(0)
    })
  })

  describe('trimTrack - edge cases', () => {
    it('handles trimming to exactly 1 point safely without crashing', () => {
      const track = createSampleTrack(10, 5, 100)
      const trimmed = trimTrack(track, 4, 4) // start === end => 1 point

      expect(trimmed.points).toHaveLength(1)
      expect(trimmed.points[0]).toBe(track.points[4])
      expect(trimmed.distance).toBe(0)
      expect(trimmed.duration).toBe(0)
      expect(trimmed.elevation).toBe(0)
      expect(trimmed.pace).toBe(0)
      expect(trimmed.splits).toEqual([])
      expect(trimmed.summary.distanceM).toBe(0)
    })

    it('handles start > end safely (returns 0 points and zeroed metrics)', () => {
      const track = createSampleTrack(10, 5, 100)
      const trimmed = trimTrack(track, 7, 2) // start > end

      expect(trimmed.points).toHaveLength(0)
      expect(trimmed.distance).toBe(0)
      expect(trimmed.duration).toBe(0)
      expect(trimmed.elevation).toBe(0)
      expect(trimmed.pace).toBe(0)
      expect(trimmed.splits).toEqual([])
      expect(trimmed.startTime).toBeNull()
      expect(trimmed.endTime).toBeNull()
    })

    it('handles out of bounds start index (< 0) by clamping to 0', () => {
      const track = createSampleTrack(10, 5, 100)
      const trimmed = trimTrack(track, -5, 3)

      expect(trimmed.points).toHaveLength(4) // indices 0, 1, 2, 3
      expect(trimmed.points[0]).toBe(track.points[0])
      expect(trimmed.points[3]).toBe(track.points[3])
    })

    it('handles out of bounds end index (>= length) by clamping to last index', () => {
      const track = createSampleTrack(10, 5, 100)
      const trimmed = trimTrack(track, 6, 999)

      expect(trimmed.points).toHaveLength(4) // indices 6, 7, 8, 9
      expect(trimmed.points[0]).toBe(track.points[6])
      expect(trimmed.points[3]).toBe(track.points[9])
    })

    it('handles indices entirely out of bounds safely', () => {
      const track = createSampleTrack(10, 5, 100)

      // Start beyond end of array
      const beyond = trimTrack(track, 20, 30)
      expect(beyond.points).toHaveLength(0)
      expect(beyond.distance).toBe(0)

      // End negative
      const negative = trimTrack(track, -10, -5)
      expect(negative.points).toHaveLength(0)
      expect(negative.distance).toBe(0)
    })

    it('handles null, undefined, or empty track safely', () => {
      const nullTrack = trimTrack(null, 0, 5)
      expect(nullTrack.points).toEqual([])
      expect(nullTrack.distance).toBe(0)
      expect(nullTrack.duration).toBe(0)

      const emptyTrack = trimTrack({ points: [] }, 0, 5)
      expect(emptyTrack.points).toEqual([])
      expect(emptyTrack.distance).toBe(0)

      const undefinedTrack = trimTrack(undefined)
      expect(undefinedTrack.points).toEqual([])
    })

    it('handles non-numeric or missing indices safely', () => {
      const track = createSampleTrack(5, 5, 100)

      // Default (no indices) retains full track
      const all = trimTrack(track)
      expect(all.points).toHaveLength(5)

      // NaN indices fall back safely
      const nanTrim = trimTrack(track, 'invalid', 'bad')
      expect(nanTrim.points).toHaveLength(5)
    })
  })

  describe('canTrimTrack predicate', () => {
    it('returns true when track has 2 or more points', () => {
      const track = createSampleTrack(2)
      expect(canTrimTrack(track)).toBe(true)
      expect(canTrimTrack(track.points)).toBe(true)
    })

    it('returns false when track has fewer than 2 points or is invalid', () => {
      expect(canTrimTrack(null)).toBe(false)
      expect(canTrimTrack({})).toBe(false)
      expect(canTrimTrack({ points: [] })).toBe(false)
      expect(canTrimTrack({ points: [{ lat: 45, lon: 9 }] })).toBe(false)
      expect(canTrimTrack([1])).toBe(false)
    })
  })

  describe('resolveTrackPath', () => {
    it('resolves string paths correctly', () => {
      expect(resolveTrackPath('2026/run-123.json')).toBe('2026/run-123.json')
      expect(resolveTrackPath('tracks/2026/run-123.json')).toBe('tracks/2026/run-123.json')
      expect(resolveTrackPath('/2026/run-123.json')).toBe('2026/run-123.json')
      expect(resolveTrackPath('2026\\run-123.json')).toBe('2026/run-123.json')
    })

    it('resolves descriptor objects with trackPath or path', () => {
      expect(resolveTrackPath({ trackPath: '2026/activity-1.json' })).toBe('2026/activity-1.json')
      expect(resolveTrackPath({ path: '2026/activity-2.json' })).toBe('2026/activity-2.json')
    })

    it('resolves activity objects with year and id or startTime', () => {
      expect(resolveTrackPath({ year: 2026, id: 'run-789' })).toBe('2026/run-789.json')
      expect(resolveTrackPath({ startTime: '2026-07-15T08:30:00Z', id: 'run-999' })).toBe('2026/run-999.json')
      expect(resolveTrackPath({ id: 'standalone-id' })).toBe('standalone-id.json')
    })

    it('returns empty string for null, undefined, or invalid input', () => {
      expect(resolveTrackPath(null)).toBe('')
      expect(resolveTrackPath('')).toBe('')
      expect(resolveTrackPath({})).toBe('')
    })
  })

  describe('deleteTrackFile', () => {
    let memoryAdapter

    beforeEach(() => {
      memoryAdapter = createMemoryCardioAdapter({
        tracks: {
          '2026/activity-001.json': { id: 'activity-001', points: [] },
          '2026/activity-002.json': { id: 'activity-002', points: [] },
        },
      })
      setCardioAdapter(memoryAdapter)
    })

    it('deletes track file by string path using memory adapter', async () => {
      expect(await memoryAdapter.hasTrack('2026/activity-001.json')).toBe(true)

      const result = await deleteTrackFile('2026/activity-001.json', memoryAdapter)
      expect(result).toBe(true)

      expect(await memoryAdapter.hasTrack('2026/activity-001.json')).toBe(false)
      expect(await memoryAdapter.hasTrack('2026/activity-002.json')).toBe(true)
    })

    it('deletes track file from activity descriptor object', async () => {
      const activity = {
        id: 'activity-002',
        startTime: '2026-04-12T10:00:00Z',
      }

      const result = await deleteTrackFile(activity, memoryAdapter)
      expect(result).toBe(true)
      expect(await memoryAdapter.hasTrack('2026/activity-002.json')).toBe(false)
    })

    it('uses global cardio adapter when adapter argument is omitted', async () => {
      const result = await deleteTrackFile('2026/activity-001.json')
      expect(result).toBe(true)
      expect(await memoryAdapter.hasTrack('2026/activity-001.json')).toBe(false)
    })

    it('returns false when trying to delete non-existent track file', async () => {
      const result = await deleteTrackFile('2026/missing.json', memoryAdapter)
      expect(result).toBe(false)
    })

    it('handles flipped (adapter, path) argument order gracefully', async () => {
      const result = await deleteTrackFile(memoryAdapter, '2026/activity-001.json')
      expect(result).toBe(true)
      expect(await memoryAdapter.hasTrack('2026/activity-001.json')).toBe(false)
    })

    it('returns false safely on invalid path input', async () => {
      expect(await deleteTrackFile(null, memoryAdapter)).toBe(false)
      expect(await deleteTrackFile('', memoryAdapter)).toBe(false)
      expect(await deleteTrackFile({}, memoryAdapter)).toBe(false)
    })
  })
})
