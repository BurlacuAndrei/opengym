import { describe, it, expect } from 'vitest'
import {
  STANDARD_DISTANCE_TARGETS,
  STANDARD_DURATION_TARGETS,
  DISTANCE_LABELS,
  DURATION_LABELS,
  getDistanceLabel,
  getDurationLabel,
  parseDistanceTarget,
  parseDurationTarget,
  calculateBestEfforts,
  updatePersonalRecords,
} from './best-efforts.js'
import { EARTH_RADIUS_METERS } from './track-math.js'

describe('Best Efforts and Personal Records (Issue #55)', () => {
  // Helpers to construct realistic tracks
  const metersPerDegLat = (EARTH_RADIUS_METERS * Math.PI) / 180

  function createLinearGpsTrack(totalMeters, speedMps, intervalSec = 1, startLat = 45.0, startLon = 9.0) {
    const track = []
    const totalTimeSec = totalMeters / speedMps
    const count = Math.floor(totalTimeSec / intervalSec) + 1
    const t0 = 1700000000000 // fixed epoch ms

    for (let i = 0; i < count; i++) {
      const elapsed = Math.min(totalTimeSec, i * intervalSec)
      const dist = elapsed * speedMps
      const lat = startLat + dist / metersPerDegLat
      const t = t0 + elapsed * 1000
      track.push({ lat, lon: startLon, time: t })
    }
    // Ensure exact final endpoint
    const finalElapsed = totalTimeSec
    const finalLat = startLat + totalMeters / metersPerDegLat
    if (track[track.length - 1].time !== t0 + finalElapsed * 1000) {
      track.push({ lat: finalLat, lon: startLon, time: t0 + finalElapsed * 1000 })
    }
    return track
  }

  describe('Standard Constants and Labels', () => {
    it('defines standard distance targets correctly', () => {
      expect(STANDARD_DISTANCE_TARGETS).toEqual([
        400,
        1000,
        1609.344,
        5000,
        10000,
        21097.5,
        42195,
      ])
    })

    it('defines standard duration targets in seconds correctly', () => {
      expect(STANDARD_DURATION_TARGETS).toEqual([
        60,
        300,
        720,
        1200,
        3600,
      ])
    })

    it('formats canonical distance labels', () => {
      expect(getDistanceLabel(400)).toBe('400m')
      expect(getDistanceLabel(1000)).toBe('1k')
      expect(getDistanceLabel(1609.344)).toBe('1mi')
      expect(getDistanceLabel(5000)).toBe('5k')
      expect(getDistanceLabel(10000)).toBe('10k')
      expect(getDistanceLabel(21097.5)).toBe('half-marathon')
      expect(getDistanceLabel(42195)).toBe('marathon')
      expect(getDistanceLabel(800)).toBe('800m')
      expect(getDistanceLabel(15000)).toBe('15k')
      expect(getDistanceLabel(null)).toBe('')
    })

    it('formats canonical duration labels', () => {
      expect(getDurationLabel(60)).toBe('1m')
      expect(getDurationLabel(300)).toBe('5m')
      expect(getDurationLabel(720)).toBe('12m')
      expect(getDurationLabel(1200)).toBe('20m')
      expect(getDurationLabel(3600)).toBe('1h')
      expect(getDurationLabel(30)).toBe('30s')
      expect(getDurationLabel(null)).toBe('')
    })

    it('parses distance target aliases', () => {
      expect(parseDistanceTarget('400m')).toBe(400)
      expect(parseDistanceTarget('1k')).toBe(1000)
      expect(parseDistanceTarget('1km')).toBe(1000)
      expect(parseDistanceTarget('1mi')).toBe(1609.344)
      expect(parseDistanceTarget('mile')).toBe(1609.344)
      expect(parseDistanceTarget('5k')).toBe(5000)
      expect(parseDistanceTarget('10k')).toBe(10000)
      expect(parseDistanceTarget('half-marathon')).toBe(21097.5)
      expect(parseDistanceTarget('marathon')).toBe(42195)
      expect(parseDistanceTarget(5000)).toBe(5000)
      expect(parseDistanceTarget('invalid')).toBe(null)
      expect(parseDistanceTarget(-10)).toBe(null)
    })

    it('parses duration target aliases', () => {
      expect(parseDurationTarget('1m')).toBe(60)
      expect(parseDurationTarget('60s')).toBe(60)
      expect(parseDurationTarget('5m')).toBe(300)
      expect(parseDurationTarget('12m')).toBe(720)
      expect(parseDurationTarget('cooper')).toBe(720)
      expect(parseDurationTarget('20m')).toBe(1200)
      expect(parseDurationTarget('ftp')).toBe(1200)
      expect(parseDurationTarget('1h')).toBe(3600)
      expect(parseDurationTarget(300)).toBe(300)
      expect(parseDurationTarget('invalid')).toBe(null)
    })
  })

  describe('Edge Cases and Guardrails', () => {
    it('handles empty or null track points gracefully without crashing', () => {
      const resEmpty = calculateBestEfforts([])
      expect(resEmpty).toEqual([])
      expect(resEmpty.distances).toEqual([])
      expect(resEmpty.durations).toEqual([])
      expect(resEmpty.isEmpty).toBe(true)

      const resNull = calculateBestEfforts(null)
      expect(resNull).toEqual([])
      expect(resNull.isEmpty).toBe(true)

      const resSingle = calculateBestEfforts([{ lat: 45.0, lon: 9.0, time: 1000 }])
      expect(resSingle).toEqual([])
      expect(resSingle.isEmpty).toBe(true)
    })

    it('does not invent intervals when track is shorter than standard targets', () => {
      // 250m track run in 50 seconds: shorter than 400m and shorter than 60s
      const shortTrack = createLinearGpsTrack(250, 5, 1)
      const efforts = calculateBestEfforts(shortTrack)

      expect(efforts).toHaveLength(0)
      expect(efforts.distances).toHaveLength(0)
      expect(efforts.durations).toHaveLength(0)
      expect(efforts['400m']).toBeUndefined()
      expect(efforts['1m']).toBeUndefined()
    })

    it('returns only achieved intervals on partial tracks', () => {
      // 1500m track in 375 seconds (4 m/s):
      // Should achieve:
      // Distances: 400m, 1000m (1k) [1mi=1609m is NOT achieved]
      // Durations: 60s (1m), 300s (5m) [720s=12m is NOT achieved]
      const track = createLinearGpsTrack(1500, 4, 1)
      const efforts = calculateBestEfforts(track)

      const distLabels = efforts.distances.map(e => e.label)
      expect(distLabels).toEqual(['400m', '1k'])
      expect(efforts['1mi']).toBeUndefined()
      expect(efforts['5k']).toBeUndefined()

      const durLabels = efforts.durations.map(e => e.label)
      expect(durLabels).toEqual(['1m', '5m'])
      expect(efforts['12m']).toBeUndefined()
      expect(efforts['20m']).toBeUndefined()
    })

    it('handles stationary periods without NaN or negative values', () => {
      // 1000m run, then 60s stationary pause, then another 1000m run
      const track1 = createLinearGpsTrack(1000, 5, 1)
      const lastPoint = track1[track1.length - 1]

      // Pause for 60s
      const pausePoints = []
      for (let s = 1; s <= 60; s++) {
        pausePoints.push({
          lat: lastPoint.lat,
          lon: lastPoint.lon,
          time: lastPoint.time + s * 1000,
        })
      }

      // Resume 1000m run at 5 m/s
      const resumeTime0 = lastPoint.time + 61000
      const track2 = []
      for (let s = 0; s <= 200; s++) {
        const d = s * 5
        track2.push({
          lat: lastPoint.lat + d / metersPerDegLat,
          lon: lastPoint.lon,
          time: resumeTime0 + s * 1000,
        })
      }

      const fullTrack = [...track1, ...pausePoints, ...track2]
      const efforts = calculateBestEfforts(fullTrack)

      expect(efforts['1k']).toBeDefined()
      // Best 1k should be achieved in 200s (1000m / 5m/s) without the pause
      expect(efforts['1k'].elapsedTime).toBeCloseTo(200, 1)
      expect(efforts['1k'].speed).toBeCloseTo(5.0, 1)
    })
  })

  describe('Sliding-Window Distance Calculations', () => {
    it('calculates exact times on a constant pace track', () => {
      // 5000m run at 4 m/s (250 s/km = 4:10 min/km pace)
      // Total duration = 1250 seconds
      const track = createLinearGpsTrack(5000, 4, 1)
      const efforts = calculateBestEfforts(track)

      // 400m at 4 m/s => 100s
      expect(efforts['400m']).toBeDefined()
      expect(efforts['400m'].elapsedTime).toBeCloseTo(100, 1)
      expect(efforts['400m'].speed).toBeCloseTo(4.0, 2)
      expect(efforts['400m'].pace).toBeCloseTo(250, 1)

      // 1000m (1k) at 4 m/s => 250s
      expect(efforts['1k']).toBeDefined()
      expect(efforts['1k'].elapsedTime).toBeCloseTo(250, 1)
      expect(efforts['1k'].speed).toBeCloseTo(4.0, 2)
      expect(efforts['1k'].pace).toBeCloseTo(250, 1)

      // 1mi (1609.344m) at 4 m/s => 402.336s
      expect(efforts['1mi']).toBeDefined()
      expect(efforts['1mi'].elapsedTime).toBeCloseTo(1609.344 / 4, 1)

      // 5000m (5k) at 4 m/s => 1250s
      expect(efforts['5k']).toBeDefined()
      expect(efforts['5k'].elapsedTime).toBeCloseTo(1250, 1)

      // 10k is NOT reached
      expect(efforts['10k']).toBeUndefined()
    })

    it('identifies the fastest interval in a variable-pace track', () => {
      // 3000m track:
      // Section 1: 1000m at 3 m/s (333.3s)
      // Section 2: 1000m surge at 5 m/s (200s)
      // Section 3: 1000m at 2 m/s (500s)
      const t0 = 1700000000000
      const track = []
      let curLat = 45.0
      let curTime = t0

      // Section 1
      for (let s = 0; s <= 200; s++) {
        const d = (s / 200) * 1000
        track.push({
          lat: 45.0 + d / metersPerDegLat,
          lon: 9.0,
          time: t0 + (d / 3) * 1000,
        })
      }
      curLat = 45.0 + 1000 / metersPerDegLat
      curTime = t0 + (1000 / 3) * 1000

      // Section 2 (Fast surge: 1000m at 5 m/s => 200s)
      for (let s = 1; s <= 200; s++) {
        const d = (s / 200) * 1000
        track.push({
          lat: curLat + d / metersPerDegLat,
          lon: 9.0,
          time: curTime + (d / 5) * 1000,
        })
      }
      curLat += 1000 / metersPerDegLat
      curTime += (1000 / 5) * 1000

      // Section 3 (Slow: 1000m at 2 m/s => 500s)
      for (let s = 1; s <= 200; s++) {
        const d = (s / 200) * 1000
        track.push({
          lat: curLat + d / metersPerDegLat,
          lon: 9.0,
          time: curTime + (d / 2) * 1000,
        })
      }

      const efforts = calculateBestEfforts(track)
      expect(efforts['1k']).toBeDefined()
      // The best 1k must be the 200s surge
      expect(efforts['1k'].elapsedTime).toBeCloseTo(200, 1)
      expect(efforts['1k'].speed).toBeCloseTo(5.0, 1)

      // The best 400m must also come from the 5 m/s section (400 / 5 = 80s)
      expect(efforts['400m']).toBeDefined()
      expect(efforts['400m'].elapsedTime).toBeCloseTo(80, 1)
    })

    it('interpolates boundaries accurately with irregular sampling intervals', () => {
      // Points at irregular intervals: 0m(0s), 150m(30s), 300m(60s), 700m(140s), 1200m(240s)
      // Constant 5 m/s speed between 300m and 1200m (900m in 180s)
      const t0 = 1700000000000
      const track = [
        { lat: 45.0, lon: 9.0, time: t0 }, // 0m
        { lat: 45.0 + 150 / metersPerDegLat, lon: 9.0, time: t0 + 40000 }, // 150m in 40s (3.75 m/s)
        { lat: 45.0 + 300 / metersPerDegLat, lon: 9.0, time: t0 + 80000 }, // 300m in 80s
        { lat: 45.0 + 700 / metersPerDegLat, lon: 9.0, time: t0 + 160000 }, // 700m in 160s (5 m/s)
        { lat: 45.0 + 1200 / metersPerDegLat, lon: 9.0, time: t0 + 260000 }, // 1200m in 260s (5 m/s)
      ]

      const efforts = calculateBestEfforts(track)
      // Best 400m in the 5 m/s section (from 300m to 700m) => exactly 80s
      expect(efforts['400m']).toBeDefined()
      expect(efforts['400m'].elapsedTime).toBeCloseTo(80, 0.5)

      // Best 1k covers from ~200m to 1200m
      expect(efforts['1k']).toBeDefined()
      expect(efforts['1k'].distance).toBe(1000)
    })
  })

  describe('Sliding-Window Duration Calculations', () => {
    it('calculates maximum distance covered across standard durations', () => {
      // 10 km run at constant 4 m/s (total duration 2500 seconds)
      const track = createLinearGpsTrack(10000, 4, 2)
      const efforts = calculateBestEfforts(track)

      // 1m (60s) at 4 m/s => 240m
      expect(efforts['1m']).toBeDefined()
      expect(efforts['1m'].duration).toBe(60)
      expect(efforts['1m'].distance).toBeCloseTo(240, 1)
      expect(efforts['1m'].speed).toBeCloseTo(4.0, 2)

      // 5m (300s) at 4 m/s => 1200m
      expect(efforts['5m']).toBeDefined()
      expect(efforts['5m'].duration).toBe(300)
      expect(efforts['5m'].distance).toBeCloseTo(1200, 1)

      // 12m (720s) at 4 m/s => 2880m
      expect(efforts['12m']).toBeDefined()
      expect(efforts['12m'].duration).toBe(720)
      expect(efforts['12m'].distance).toBeCloseTo(2880, 1)

      // 20m (1200s) at 4 m/s => 4800m
      expect(efforts['20m']).toBeDefined()
      expect(efforts['20m'].duration).toBe(1200)
      expect(efforts['20m'].distance).toBeCloseTo(4800, 1)

      // 1h (3600s) is NOT reached (track only 2500s)
      expect(efforts['1h']).toBeUndefined()
    })

    it('captures the highest-distance window during a mid-run acceleration', () => {
      // 20 minute run (1200s):
      // 0-300s: 3 m/s (900m)
      // 300-600s: 6 m/s sprint (1800m)
      // 600-1200s: 3 m/s (1800m)
      const points = []
      let curDist = 0
      for (let t = 0; t <= 1200; t += 5) {
        if (t > 0) {
          const speed = (t > 300 && t <= 600) ? 6 : 3
          curDist += speed * 5
        }
        points.push({
          cumulativeDistance: curDist,
          elapsedTime: t,
        })
      }

      const efforts = calculateBestEfforts(points)
      // Best 5m (300s) should be the 300s-600s window: 300s * 6 m/s = 1800m
      expect(efforts['5m']).toBeDefined()
      expect(efforts['5m'].distance).toBeCloseTo(1800, 5)
      expect(efforts['5m'].speed).toBeCloseTo(6.0, 1)

      // Best 1m (60s) should also be at 6 m/s: 60 * 6 = 360m
      expect(efforts['1m']).toBeDefined()
      expect(efforts['1m'].distance).toBeCloseTo(360, 5)
    })
  })

  describe('Alternative Point Formats and Custom Targets', () => {
    it('supports precomputed distance and elapsedTime points', () => {
      const points = [
        { distance: 0, time: 0 },
        { distance: 500, time: 100 },
        { distance: 1000, time: 200 },
        { distance: 2000, time: 400 },
      ]

      const efforts = calculateBestEfforts(points, { distances: [1000], durations: [100] })
      expect(efforts.distances).toHaveLength(1)
      expect(efforts['1k'].elapsedTime).toBeCloseTo(200, 1)
      expect(efforts.durations).toHaveLength(1)
      expect(efforts.durations[0].distance).toBeCloseTo(500, 1)
    })

    it('supports array target specification', () => {
      const track = createLinearGpsTrack(2000, 5, 1)
      const efforts = calculateBestEfforts(track, [400, 1000])

      expect(efforts.distances).toHaveLength(2)
      expect(efforts.durations).toHaveLength(0)
      expect(efforts['400m']).toBeDefined()
      expect(efforts['1k']).toBeDefined()
    })

    it('supports string labels in custom targets', () => {
      const track = createLinearGpsTrack(6000, 4, 2)
      const efforts = calculateBestEfforts(track, {
        distances: ['1k', '5k'],
        durations: ['1m', '12m'],
      })

      expect(efforts.distances).toHaveLength(2)
      expect(efforts.durations).toHaveLength(2)
      expect(efforts['1k']).toBeDefined()
      expect(efforts['5k']).toBeDefined()
      expect(efforts['1m']).toBeDefined()
      expect(efforts['12m']).toBeDefined()
    })
  })

  describe('Personal Records Engine: updatePersonalRecords', () => {
    it('initializes all efforts as new PRs when no existing records exist', () => {
      const activityEfforts = [
        { type: 'distance', target: 1000, label: '1k', elapsedTime: 240, distance: 1000 },
        { type: 'distance', target: 5000, label: '5k', elapsedTime: 1300, distance: 5000 },
        { type: 'duration', target: 60, label: '1m', duration: 60, distance: 300 },
      ]

      const updated = updatePersonalRecords(null, activityEfforts)

      expect(updated.hasNewPr).toBe(true)
      expect(updated.newRecords).toHaveLength(3)
      expect(updated['1k'].elapsedTime).toBe(240)
      expect(updated['1k'].isNewPr).toBe(true)
      expect(updated['5k'].elapsedTime).toBe(1300)
      expect(updated['1m'].distance).toBe(300)
    })

    it('updates distance PR when new effort is faster', () => {
      const existing = {
        '1k': { type: 'distance', target: 1000, label: '1k', elapsedTime: 250, distance: 1000 },
        '5k': { type: 'distance', target: 5000, label: '5k', elapsedTime: 1400, distance: 5000 },
      }

      // 1k is faster (235s vs 250s), 5k is slower (1450s vs 1400s)
      const newEfforts = [
        { type: 'distance', target: 1000, label: '1k', elapsedTime: 235, distance: 1000 },
        { type: 'distance', target: 5000, label: '5k', elapsedTime: 1450, distance: 5000 },
      ]

      const updated = updatePersonalRecords(existing, newEfforts)

      // 1k is updated
      expect(updated['1k'].elapsedTime).toBe(235)
      expect(updated['1k'].isNewPr).toBe(true)
      expect(updated['1k'].previousRecord.elapsedTime).toBe(250)

      // 5k is NOT updated, keeps old record
      expect(updated['5k'].elapsedTime).toBe(1400)
      expect(updated['5k'].isNewPr).toBe(false)

      expect(updated.newRecords).toHaveLength(1)
      expect(updated.newRecords[0].label).toBe('1k')
    })

    it('updates duration PR when new effort covers greater distance', () => {
      const existing = {
        '1m': { type: 'duration', target: 60, label: '1m', duration: 60, distance: 320 },
      }

      // New 1m covers 350m (improvement!)
      const newEfforts = [
        { type: 'duration', target: 60, label: '1m', duration: 60, distance: 350 },
      ]

      const updated = updatePersonalRecords(existing, newEfforts)
      expect(updated['1m'].distance).toBe(350)
      expect(updated['1m'].isNewPr).toBe(true)
      expect(updated['1m'].previousRecord.distance).toBe(320)
      expect(updated.hasNewPr).toBe(true)
    })

    it('preserves existing records that were not attempted in current activity', () => {
      const existing = {
        '1k': { type: 'distance', target: 1000, label: '1k', elapsedTime: 250 },
        'marathon': { type: 'distance', target: 42195, label: 'marathon', elapsedTime: 12000 },
      }

      // Short run only achieved 1k
      const newEfforts = [
        { type: 'distance', target: 1000, label: '1k', elapsedTime: 230 },
      ]

      const updated = updatePersonalRecords(existing, newEfforts)
      expect(updated['marathon']).toBeDefined()
      expect(updated['marathon'].elapsedTime).toBe(12000)
      expect(updated['marathon'].isNewPr).toBe(false)
    })

    it('is a strictly pure function that does not mutate inputs', () => {
      const existing = Object.freeze({
        '1k': Object.freeze({ type: 'distance', target: 1000, label: '1k', elapsedTime: 250 }),
      })
      const efforts = Object.freeze([
        Object.freeze({ type: 'distance', target: 1000, label: '1k', elapsedTime: 230 }),
      ])

      const updated = updatePersonalRecords(existing, efforts)
      expect(updated['1k'].elapsedTime).toBe(230)
      expect(existing['1k'].elapsedTime).toBe(250)
    })

    it('supports array input format for existing records', () => {
      const existingArray = [
        { type: 'distance', target: 1000, label: '1k', elapsedTime: 250 },
      ]
      const newEfforts = [
        { type: 'distance', target: 1000, label: '1k', elapsedTime: 230 },
      ]

      const updated = updatePersonalRecords(existingArray, newEfforts)
      expect(Array.isArray(updated)).toBe(true)
      expect(updated['1k'].elapsedTime).toBe(230)
      expect(updated.newRecords).toHaveLength(1)
    })

    it('supports seamless integration with calculateBestEfforts output', () => {
      // 5k track at 5 m/s
      const track1 = createLinearGpsTrack(5000, 4, 1)
      const efforts1 = calculateBestEfforts(track1)
      const prs1 = updatePersonalRecords({}, efforts1)

      expect(prs1.hasNewPr).toBe(true)
      const old1kTime = prs1['1k'].elapsedTime

      // Run faster next week at 5 m/s
      const track2 = createLinearGpsTrack(5000, 5, 1)
      const efforts2 = calculateBestEfforts(track2)
      const prs2 = updatePersonalRecords(prs1, efforts2)

      expect(prs2.hasNewPr).toBe(true)
      expect(prs2['1k'].elapsedTime).toBeLessThan(old1kTime)
      expect(prs2['1k'].isNewPr).toBe(true)
      expect(prs2['1k'].previousRecord.elapsedTime).toBe(old1kTime)
    })
  })
})
