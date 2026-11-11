import { describe, it, expect } from 'vitest'
import {
  EARTH_RADIUS_METERS,
  METERS_PER_KM,
  METERS_PER_MILE,
  DEFAULT_MOVING_SPEED_THRESHOLD,
  DEFAULT_RDP_EPSILON,
  DEFAULT_ELEVATION_WINDOW,
  MET_BY_ACTIVITY,
  getPointLat,
  getPointLon,
  getPointEle,
  getPointTime,
  isValidCoordinate,
  isValidPoint,
  haversineDistance,
  haversine,
  totalDistance,
  computeTotalDistance,
  pointSpeed,
  isMoving,
  computeElapsedTime,
  computeMovingTime,
  filterMovingPoints,
  rollingSpeed,
  computeRollingSpeed,
  speedToPace,
  rollingPace,
  computeRollingPace,
  smoothElevation,
  computeElevationGain,
  computeSplits,
  getActivityMet,
  estimateCalories,
  ramerDouglasPeucker,
  rdp,
  compactTrack,
  analyzeTrack,
} from './track-math.js'

describe('GPS Track Math (Issue #46)', () => {
  // ---------------------------------------------------------------------------
  // Coordinate Extraction & Normalization
  // ---------------------------------------------------------------------------
  describe('Coordinate Extraction & Normalization', () => {
    it('extracts lat/lon from {lat, lon} and {lat, lng}', () => {
      expect(getPointLat({ lat: 45.5, lon: 9.2 })).toBe(45.5)
      expect(getPointLon({ lat: 45.5, lon: 9.2 })).toBe(9.2)

      expect(getPointLat({ lat: 40.71, lng: -74.0 })).toBe(40.71)
      expect(getPointLon({ lat: 40.71, lng: -74.0 })).toBe(-74.0)
    })

    it('extracts lat/lon from {latitude, longitude}', () => {
      expect(getPointLat({ latitude: 51.5, longitude: -0.1 })).toBe(51.5)
      expect(getPointLon({ latitude: 51.5, longitude: -0.1 })).toBe(-0.1)
    })

    it('extracts from array [lat, lon, ele, time]', () => {
      const p = [46.1, 8.9, 350, 1600000000000]
      expect(getPointLat(p)).toBe(46.1)
      expect(getPointLon(p)).toBe(8.9)
      expect(getPointEle(p)).toBe(350)
      expect(getPointTime(p)).toBe(1600000000000)
    })

    it('handles numeric string coordinates', () => {
      expect(getPointLat({ lat: '45.123', lon: '9.456' })).toBe(45.123)
      expect(getPointLon({ lat: '45.123', lon: '9.456' })).toBe(9.456)
    })

    it('handles zero coordinates correctly (Null Island)', () => {
      expect(getPointLat({ lat: 0, lon: 0 })).toBe(0)
      expect(getPointLon({ lat: 0, lon: 0 })).toBe(0)
      expect(isValidPoint({ lat: 0, lon: 0 })).toBe(true)
      expect(isValidCoordinate(0, 0)).toBe(true)
    })

    it('rejects out of bounds and invalid coordinates', () => {
      expect(getPointLat({ lat: 95, lon: 10 })).toBeNull()
      expect(getPointLat({ lat: -91, lon: 10 })).toBeNull()
      expect(getPointLon({ lat: 10, lon: 185 })).toBeNull()
      expect(getPointLon({ lat: 10, lon: -181 })).toBeNull()
      expect(getPointLat({ lat: NaN, lon: 10 })).toBeNull()
      expect(getPointLon({ lat: 10, lon: 'abc' })).toBeNull()
      expect(getPointLat(null)).toBeNull()
      expect(getPointLon(undefined)).toBeNull()
      expect(isValidPoint(null)).toBe(false)
      expect(isValidPoint({ lat: 'invalid', lon: 10 })).toBe(false)
    })

    it('extracts elevation from ele, alt, elevation', () => {
      expect(getPointEle({ lat: 45, lon: 9, ele: 250 })).toBe(250)
      expect(getPointEle({ lat: 45, lon: 9, alt: 310.5 })).toBe(310.5)
      expect(getPointEle({ lat: 45, lon: 9, elevation: '400' })).toBe(400)
      expect(getPointEle({ lat: 45, lon: 9, ele: null })).toBeNull()
      expect(getPointEle({ lat: 45, lon: 9 })).toBeNull()
    })

    it('extracts timestamps from number, Date, and ISO string', () => {
      const now = 1700000000000
      expect(getPointTime({ time: now })).toBe(now)
      expect(getPointTime({ timestamp: new Date('2026-07-11T08:00:00Z') })).toBe(
        Date.parse('2026-07-11T08:00:00Z')
      )
      expect(getPointTime({ time: '2026-07-11T08:00:00Z' })).toBe(
        Date.parse('2026-07-11T08:00:00Z')
      )
      // Converts epoch seconds to ms
      expect(getPointTime({ time: 1700000000 })).toBe(1700000000000)
      expect(getPointTime({ lat: 45, lon: 9 })).toBeNull()
      expect(getPointTime(null)).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // 1. Haversine Distance
  // ---------------------------------------------------------------------------
  describe('Haversine Distance', () => {
    it('computes distance between Paris and London (~343 km)', () => {
      // Paris: 48.8566 N, 2.3522 E
      // London: 51.5074 N, -0.1278 W
      const d = haversineDistance(
        { lat: 48.8566, lon: 2.3522 },
        { lat: 51.5074, lon: -0.1278 }
      )
      // Expected ~343,556 meters (within 0.5% tolerance)
      expect(d).toBeGreaterThan(340000)
      expect(d).toBeLessThan(346000)
    })

    it('accepts 4 coordinate numbers as arguments', () => {
      const d1 = haversineDistance(48.8566, 2.3522, 51.5074, -0.1278)
      const d2 = haversine(
        { lat: 48.8566, lon: 2.3522 },
        { lat: 51.5074, lon: -0.1278 }
      )
      expect(d1).toBeCloseTo(d2, 2)
    })

    it('computes distance for 1 degree of latitude at equator (~111.19 km)', () => {
      const d = haversineDistance(0, 0, 1, 0)
      expect(d).toBeCloseTo((Math.PI / 180) * EARTH_RADIUS_METERS, 0)
      expect(d / 1000).toBeCloseTo(111.195, 0)
    })

    it('returns 0 for identical points', () => {
      expect(haversineDistance({ lat: 45.0, lon: 9.0 }, { lat: 45.0, lon: 9.0 })).toBe(0)
    })

    it('returns 0 safely for null, missing, or invalid coordinates', () => {
      expect(haversineDistance(null, { lat: 45, lon: 9 })).toBe(0)
      expect(haversineDistance({ lat: 45, lon: 9 }, null)).toBe(0)
      expect(haversineDistance({ lat: 999, lon: 0 }, { lat: 0, lon: 0 })).toBe(0)
      expect(haversineDistance(undefined, undefined)).toBe(0)
    })

    it('calculates total distance of a multi-point route', () => {
      const p1 = { lat: 45.000, lon: 9.000 }
      const p2 = { lat: 45.005, lon: 9.000 }
      const p3 = { lat: 45.010, lon: 9.000 }

      const d12 = haversineDistance(p1, p2)
      const d23 = haversineDistance(p2, p3)
      const total = totalDistance([p1, p2, p3])

      expect(total).toBeCloseTo(d12 + d23, 2)
      expect(computeTotalDistance([p1, p2, p3])).toBeCloseTo(total, 2)
    })

    it('handles empty or single point tracks in totalDistance', () => {
      expect(totalDistance([])).toBe(0)
      expect(totalDistance([{ lat: 45, lon: 9 }])).toBe(0)
      expect(totalDistance(null)).toBe(0)
    })

    it('skips invalid points seamlessly in totalDistance', () => {
      const p1 = { lat: 45.000, lon: 9.000 }
      const invalid = { lat: 'bad', lon: 999 }
      const p2 = { lat: 45.010, lon: 9.000 }

      const totalWithInvalid = totalDistance([p1, invalid, p2])
      const expected = haversineDistance(p1, p2)
      expect(totalWithInvalid).toBeCloseTo(expected, 2)
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Moving Time & Speed Filtering
  // ---------------------------------------------------------------------------
  describe('Moving Time & Speed Filtering', () => {
    it('computes pointSpeed in m/s between two timestamped points', () => {
      const p1 = { lat: 45.0000, lon: 9.0000, time: 10000 }
      // ~556 meters north in 100 seconds => ~5.56 m/s
      const p2 = { lat: 45.0050, lon: 9.0000, time: 110000 }

      const spd = pointSpeed(p1, p2)
      const dist = haversineDistance(p1, p2)
      expect(spd).toBeCloseTo(dist / 100, 3)
      expect(spd).toBeGreaterThan(5)
    })

    it('returns 0 speed when time delta is zero or negative', () => {
      const p1 = { lat: 45.0, lon: 9.0, time: 1000 }
      const p2 = { lat: 45.1, lon: 9.0, time: 1000 }
      expect(pointSpeed(p1, p2)).toBe(0)

      const p3 = { lat: 45.1, lon: 9.0, time: 500 }
      expect(pointSpeed(p1, p3)).toBe(0)
    })

    it('identifies moving points based on speed threshold', () => {
      const p1 = { lat: 45.0000, lon: 9.0000, time: 0 }
      const pMoving = { lat: 45.0001, lon: 9.0000, time: 2000 } // ~11m in 2s = 5.5 m/s
      const pStopped = { lat: 45.0000, lon: 9.0000, time: 10000 } // 0 m/s

      expect(isMoving(p1, pMoving)).toBe(true)
      expect(isMoving(p1, pStopped)).toBe(false)
    })

    it('computes elapsed time correctly', () => {
      const points = [
        { lat: 45.0, lon: 9.0, time: 1000 },
        { lat: 45.1, lon: 9.0, time: 4000 },
        { lat: 45.2, lon: 9.0, time: 11000 },
      ]
      expect(computeElapsedTime(points)).toBe(10) // 11000 - 1000 = 10000ms = 10s
      expect(computeElapsedTime([])).toBe(0)
      expect(computeElapsedTime([{ lat: 45, lon: 9 }])).toBe(0)
    })

    it('computes moving time filtering out stationary periods', () => {
      // 10s moving fast, then 30s standing still at red light, then 20s moving
      const t0 = 1000000
      const track = [
        { lat: 45.0000, lon: 9.0000, time: t0 },
        { lat: 45.0005, lon: 9.0000, time: t0 + 10000 }, // ~55m in 10s = 5.5 m/s (MOVING)
        { lat: 45.0005, lon: 9.0000, time: t0 + 40000 }, // 0m in 30s = 0 m/s (STOPPED)
        { lat: 45.0015, lon: 9.0000, time: t0 + 60000 }, // ~111m in 20s = 5.5 m/s (MOVING)
      ]

      const elapsed = computeElapsedTime(track)
      const moving = computeMovingTime(track, { threshold: 1.0 })

      expect(elapsed).toBe(60)
      expect(moving).toBe(30) // 10s + 20s = 30s moving
    })

    it('filters stopped points while keeping boundaries', () => {
      const t0 = 1000
      const track = [
        { lat: 45.0000, lon: 9.0000, time: t0 },
        { lat: 45.0010, lon: 9.0000, time: t0 + 10000 }, // moving
        { lat: 45.0010, lon: 9.0000, time: t0 + 20000 }, // stopped
        { lat: 45.0010, lon: 9.0000, time: t0 + 30000 }, // stopped
        { lat: 45.0020, lon: 9.0000, time: t0 + 40000 }, // moving
      ]

      const filtered = filterMovingPoints(track, { threshold: 1.0 })
      expect(filtered.length).toBeLessThan(track.length)
      expect(filtered[0]).toBe(track[0])
      expect(filtered[filtered.length - 1]).toBe(track[track.length - 1])
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Rolling Pace and Rolling Speed
  // ---------------------------------------------------------------------------
  describe('Rolling Pace and Rolling Speed', () => {
    it('converts speed to pace in min/km and min/mi', () => {
      // 3.3333 m/s = 12 km/h = 5:00 min/km
      const speed = 1000 / 300
      expect(speedToPace(speed, 'kg')).toBeCloseTo(5.0, 2)
      expect(speedToPace(speed, 'min/km')).toBeCloseTo(5.0, 2)

      // Imperial: min/mi
      const paceMi = speedToPace(speed, 'lbs')
      expect(paceMi).toBeCloseTo(5.0 * (METERS_PER_MILE / 1000), 2)

      // Zero or negative speed returns 0
      expect(speedToPace(0)).toBe(0)
      expect(speedToPace(-5)).toBe(0)
    })

    it('computes rolling speeds across track points', () => {
      const t0 = 1000000
      const track = [
        { lat: 45.0000, lon: 9.0000, time: t0 },
        { lat: 45.0002, lon: 9.0000, time: t0 + 5000 }, // ~22m in 5s ~ 4.4 m/s
        { lat: 45.0004, lon: 9.0000, time: t0 + 10000 },
        { lat: 45.0006, lon: 9.0000, time: t0 + 15000 },
      ]

      const speeds = rollingSpeed(track, { windowSeconds: 10 })
      expect(speeds).toHaveLength(track.length)
      expect(speeds[0]).toBe(0)
      expect(speeds[1]).toBeGreaterThan(3)
      expect(speeds[2]).toBeGreaterThan(3)
      expect(computeRollingSpeed(track)).toEqual(speeds)
    })

    it('computes rolling pace series', () => {
      const t0 = 1000000
      const track = [
        { lat: 45.0000, lon: 9.0000, time: t0 },
        { lat: 45.0005, lon: 9.0000, time: t0 + 10000 }, // ~55m in 10s ~ 5.5 m/s (~3.0 min/km)
        { lat: 45.0010, lon: 9.0000, time: t0 + 20000 },
      ]

      const paces = rollingPace(track, { unit: 'kg', windowSeconds: 10 })
      expect(paces).toHaveLength(3)
      expect(paces[0]).toBe(0)
      expect(paces[1]).toBeGreaterThan(2.5)
      expect(paces[1]).toBeLessThan(3.5)
      expect(computeRollingPace(track, { unit: 'kg' })).toEqual(paces)
    })

    it('handles empty points in rolling speed and pace', () => {
      expect(rollingSpeed([])).toEqual([])
      expect(rollingPace([])).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Windowed Elevation Smoothing & Ascent/Descent
  // ---------------------------------------------------------------------------
  describe('Windowed Elevation Smoothing & Ascent/Descent', () => {
    it('smoothes noisy GPS elevation using sliding window', () => {
      // Steady climb at 100m, 110m, 120m, 130m, 140m with high-frequency jitter
      const raw = [
        { lat: 45.0, lon: 9.0, ele: 100 },
        { lat: 45.0, lon: 9.0, ele: 118 }, // jitter +8
        { lat: 45.0, lon: 9.0, ele: 112 }, // jitter -8
        { lat: 45.0, lon: 9.0, ele: 139 }, // jitter +9
        { lat: 45.0, lon: 9.0, ele: 133 }, // jitter -7
        { lat: 45.0, lon: 9.0, ele: 150 },
      ]

      const smoothed = smoothElevation(raw, { windowSize: 3 })
      expect(smoothed).toHaveLength(raw.length)
      // Original objects not mutated
      expect(raw[1].ele).toBe(118)
      // Smoothed value should be averaged (e.g. index 1: (100 + 118 + 112) / 3 = 110)
      expect(smoothed[1].ele).toBeCloseTo(110, 0)
    })

    it('supports EMA (exponential moving average) smoothing method', () => {
      const raw = [
        { lat: 45.0, lon: 9.0, ele: 100 },
        { lat: 45.0, lon: 9.0, ele: 110 },
        { lat: 45.0, lon: 9.0, ele: 120 },
      ]
      const ema = smoothElevation(raw, { method: 'ema', alpha: 0.5 })
      expect(ema).toHaveLength(3)
      expect(ema[0].ele).toBe(100)
      expect(ema[1].ele).toBe(105) // 0.5 * 110 + 0.5 * 100 = 105
      expect(ema[2].ele).toBe(112.5) // 0.5 * 120 + 0.5 * 105 = 112.5
    })

    it('computes elevation gain and loss with threshold to reject noise', () => {
      // Route goes 100m -> 150m (gain 50) -> 120m (loss 30) -> 180m (gain 60)
      const points = [
        { lat: 45.0, lon: 9.0, ele: 100 },
        { lat: 45.0, lon: 9.0, ele: 150 },
        { lat: 45.0, lon: 9.0, ele: 120 },
        { lat: 45.0, lon: 9.0, ele: 180 },
      ]

      const stats = computeElevationGain(points, { smooth: false, threshold: 1.0 })
      expect(stats.gain).toBe(110) // 50 + 60 = 110m gain
      expect(stats.loss).toBe(30)  // 30m loss
      expect(stats.min).toBe(100)
      expect(stats.max).toBe(180)
    })

    it('rejects micro-jitter under threshold', () => {
      const flatWithJitter = [
        { lat: 45.0, lon: 9.0, ele: 100.0 },
        { lat: 45.0, lon: 9.0, ele: 100.2 },
        { lat: 45.0, lon: 9.0, ele: 99.8 },
        { lat: 45.0, lon: 9.0, ele: 100.1 },
      ]
      const stats = computeElevationGain(flatWithJitter, { smooth: false, threshold: 1.0 })
      expect(stats.gain).toBe(0)
      expect(stats.loss).toBe(0)
      expect(stats.min).toBe(99.8)
      expect(stats.max).toBe(100.2)
    })

    it('handles empty and points without elevation safely', () => {
      expect(computeElevationGain([])).toEqual({ gain: 0, loss: 0, min: null, max: null })
      expect(computeElevationGain([{ lat: 45, lon: 9 }])).toEqual({
        gain: 0,
        loss: 0,
        min: null,
        max: null,
      })
      expect(smoothElevation([])).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Split Computation
  // ---------------------------------------------------------------------------
  describe('Split Computation', () => {
    it('computes metric 1000m splits with linear boundary interpolation', () => {
      // Create a 2500m straight track:
      // ~111,133m per degree lat. 2500m / 111133 = 0.022495 deg lat.
      const metersPerDegLat = (EARTH_RADIUS_METERS * Math.PI) / 180
      const startLat = 45.0
      const pointCount = 26 // every 100m: 0 to 2500m
      const startTime = 1700000000000
      const speedMps = 3.333 // 5:00 min/km

      const track = []
      for (let i = 0; i < pointCount; i++) {
        const d = i * 100
        const lat = startLat + (d / metersPerDegLat)
        const t = startTime + (d / speedMps) * 1000
        const ele = 200 + i * 2 // +2m per 100m => +20m per km
        track.push({ lat, lon: 9.0, ele, time: t })
      }

      const splits = computeSplits(track, { unit: 'kg' })

      // Should have:
      // Split 1: 1000m
      // Split 2: 1000m
      // Split 3: 500m (partial)
      expect(splits).toHaveLength(3)

      expect(splits[0].split).toBe(1)
      expect(splits[0].distance).toBe(1000)
      expect(splits[0].cumulativeDistance).toBe(1000)
      expect(splits[0].isPartial).toBe(false)
      expect(splits[0].pace).toBeCloseTo(5.0, 1) // ~5.0 min/km
      expect(splits[0].elevationGain).toBeCloseTo(20, 0)

      expect(splits[1].split).toBe(2)
      expect(splits[1].distance).toBe(1000)
      expect(splits[1].cumulativeDistance).toBe(2000)
      expect(splits[1].isPartial).toBe(false)

      expect(splits[2].split).toBe(3)
      expect(splits[2].distance).toBeCloseTo(500, 0)
      expect(splits[2].isPartial).toBe(true)
    })

    it('computes imperial 1609.344m splits when unit is lbs', () => {
      // 3500m track => 2 full miles (3218.7m) + 1 partial mile
      const startLat = 45.0
      const track = []
      const startTime = 1700000000000

      for (let i = 0; i <= 35; i++) {
        const d = i * 100
        const lat = startLat + (d / 111133)
        const t = startTime + (d / 3.0) * 1000
        track.push({ lat, lon: 9.0, time: t })
      }

      const splits = computeSplits(track, { unit: 'lbs' })
      expect(splits).toHaveLength(3)
      expect(splits[0].distance).toBeCloseTo(METERS_PER_MILE, 1)
      expect(splits[0].isPartial).toBe(false)
      expect(splits[1].distance).toBeCloseTo(METERS_PER_MILE, 1)
      expect(splits[1].isPartial).toBe(false)
      expect(splits[2].isPartial).toBe(true)
    })

    it('handles empty tracks or track shorter than 1m', () => {
      expect(computeSplits([])).toEqual([])
      expect(computeSplits([{ lat: 45, lon: 9 }])).toEqual([])
      expect(computeSplits([
        { lat: 45.0, lon: 9.0 },
        { lat: 45.0, lon: 9.0 },
      ])).toEqual([])
    })

    it('returns a single partial split when track is shorter than split distance', () => {
      const track = [
        { lat: 45.000, lon: 9.0, time: 0 },
        { lat: 45.004, lon: 9.0, time: 100000 }, // ~444m
      ]
      const splits = computeSplits(track, { unit: 'kg' })
      expect(splits).toHaveLength(1)
      expect(splits[0].isPartial).toBe(true)
      expect(splits[0].distance).toBeGreaterThan(400)
      expect(splits[0].distance).toBeLessThan(500)
    })
  })

  // ---------------------------------------------------------------------------
  // 6. MET-Based Calorie Estimation
  // ---------------------------------------------------------------------------
  describe('MET-Based Calorie Estimation', () => {
    it('returns base MET per activity type', () => {
      expect(getActivityMet('run')).toBe(MET_BY_ACTIVITY.run)
      expect(getActivityMet('ride')).toBe(MET_BY_ACTIVITY.ride)
      expect(getActivityMet('bike')).toBe(MET_BY_ACTIVITY.ride)
      expect(getActivityMet('walk')).toBe(MET_BY_ACTIVITY.walk)
      expect(getActivityMet('hike')).toBe(MET_BY_ACTIVITY.hike)
    })

    it('adjusts MET dynamically for running speed', () => {
      expect(getActivityMet('run', 7.0)).toBe(8.0)
      expect(getActivityMet('run', 10.0)).toBe(10.0)
      expect(getActivityMet('run', 15.0)).toBe(14.0)
    })

    it('adjusts MET dynamically for cycling speed', () => {
      expect(getActivityMet('ride', 15.0)).toBe(5.5)
      expect(getActivityMet('ride', 22.0)).toBe(8.0)
      expect(getActivityMet('ride', 30.0)).toBe(12.0)
    })

    it('calculates calories based on weight, duration, and activity', () => {
      // 70 kg runner, 1 hour run at ~10 km/h (MET 10.0) => 10.0 * 70 * 1 = 700 kcal
      const cal = estimateCalories({
        activity: 'run',
        weightKg: 70,
        durationSeconds: 3600,
        speedKmh: 10.0,
      })
      expect(cal).toBe(700)
    })

    it('handles weight given in lbs', () => {
      // 154.32 lbs ≈ 70 kg
      const calKg = estimateCalories({
        activity: 'walk',
        weightKg: 70,
        durationSeconds: 3600,
      })
      const calLbs = estimateCalories({
        activity: 'walk',
        weightLbs: 154.32,
        durationSeconds: 3600,
      })
      expect(Math.abs(calKg - calLbs)).toBeLessThanOrEqual(2)
    })

    it('adds elevation work adjustment for hiking', () => {
      const flatHike = estimateCalories({
        activity: 'hike',
        weightKg: 70,
        durationSeconds: 3600,
        elevationGainM: 0,
      })
      const steepHike = estimateCalories({
        activity: 'hike',
        weightKg: 70,
        durationSeconds: 3600,
        elevationGainM: 500,
      })
      expect(steepHike).toBeGreaterThan(flatHike)
    })

    it('returns 0 calories for 0 duration or negative values', () => {
      expect(estimateCalories({ durationSeconds: 0 })).toBe(0)
      expect(estimateCalories({ durationSeconds: -100 })).toBe(0)
    })

    it('uses fallback default weight when unspecified', () => {
      const cal = estimateCalories({
        activity: 'run',
        durationSeconds: 3600,
      })
      expect(cal).toBeGreaterThan(500)
    })
  })

  // ---------------------------------------------------------------------------
  // 7. Ramer-Douglas-Peucker (RDP) Compaction
  // ---------------------------------------------------------------------------
  describe('Ramer-Douglas-Peucker (RDP) Compaction', () => {
    it('simplifies a collinear series of points to just endpoints', () => {
      // 10 points along a straight meridian
      const straightLine = []
      for (let i = 0; i < 10; i++) {
        straightLine.push({ lat: 45.0 + i * 0.001, lon: 9.0 })
      }

      const compacted = ramerDouglasPeucker(straightLine, 5.0)
      expect(compacted).toHaveLength(2)
      expect(compacted[0]).toBe(straightLine[0])
      expect(compacted[1]).toBe(straightLine[9])
      expect(rdp(straightLine, 5.0)).toEqual(compacted)
      expect(compactTrack(straightLine, 5.0)).toEqual(compacted)
    })

    it('preserves significant turn corners that exceed epsilon', () => {
      // Segment: (45.0, 9.0) -> (45.01, 9.0) -> (45.01, 9.01) -> (45.02, 9.01)
      // Large L-shape dogleg ~1 km wide
      const track = [
        { lat: 45.00, lon: 9.00 },
        { lat: 45.01, lon: 9.00 }, // corner 1
        { lat: 45.01, lon: 9.01 }, // corner 2
        { lat: 45.02, lon: 9.01 },
      ]

      const compacted = ramerDouglasPeucker(track, 10.0) // 10 meter epsilon
      expect(compacted).toHaveLength(4) // Both corners kept because deflection >> 10m
    })

    it('filters small jitter deviations below epsilon', () => {
      // 100m straight line with 1m jitter in the middle
      // 1m in deg lon at lat 45 ~ 1 / (111412 * cos(45)) ~ 0.0000127
      const track = [
        { lat: 45.000, lon: 9.000 },
        { lat: 45.0005, lon: 9.00001 }, // ~1m jitter
        { lat: 45.001, lon: 9.000 },
      ]

      const compacted = ramerDouglasPeucker(track, 5.0) // 5 meter epsilon
      expect(compacted).toHaveLength(2)
    })

    it('handles edge cases: empty, 1 point, 2 points, epsilon <= 0', () => {
      expect(ramerDouglasPeucker([])).toEqual([])
      expect(ramerDouglasPeucker([{ lat: 45, lon: 9 }])).toHaveLength(1)
      expect(ramerDouglasPeucker([{ lat: 45, lon: 9 }, { lat: 46, lon: 9 }])).toHaveLength(2)

      const pts = [{ lat: 45, lon: 9 }, { lat: 45.5, lon: 9 }, { lat: 46, lon: 9 }]
      expect(ramerDouglasPeucker(pts, 0)).toHaveLength(3)
    })
  })

  // ---------------------------------------------------------------------------
  // 8. Full Track Analysis
  // ---------------------------------------------------------------------------
  describe('Full Track Analysis (analyzeTrack)', () => {
    it('computes end-to-end metrics on realistic track data', () => {
      const startTime = 1700000000000
      const track = []
      let currentTime = startTime
      // 3 km run with 30s pause at 1500m
      for (let i = 0; i <= 30; i++) {
        const d = i * 100
        const lat = 45.0 + (d / 111133)
        const ele = 200 + Math.sin(i / 3) * 15 // undulating elevation
        track.push({ lat, lon: 9.0, ele, time: currentTime })

        // At 1500m (i === 15), simulate 30s stationary stop
        if (i === 15) {
          currentTime += 30000
          track.push({ lat, lon: 9.0, ele, time: currentTime })
        }
        currentTime += (100 / 3.33) * 1000
      }

      const summary = analyzeTrack(track, {
        activity: 'run',
        weightKg: 72,
        unit: 'kg',
      })

      expect(summary.pointCount).toBe(32)
      expect(summary.totalDistance).toBeCloseTo(3000, -2) // ~3000m
      expect(summary.elapsedTime).toBeGreaterThan(summary.movingTime)
      expect(summary.stoppedTime).toBeGreaterThanOrEqual(25)
      expect(summary.avgMovingSpeed).toBeGreaterThan(summary.avgSpeed)
      expect(summary.elevationGain).toBeGreaterThan(0)
      expect(summary.elevationLoss).toBeGreaterThan(0)
      expect(summary.calories).toBeGreaterThan(0)
      expect(summary.splits.length).toBeGreaterThanOrEqual(3)
      expect(summary.compactedCount).toBeLessThanOrEqual(summary.pointCount)
    })

    it('handles empty points array gracefully in analyzeTrack', () => {
      const empty = analyzeTrack([])
      expect(empty.pointCount).toBe(0)
      expect(empty.totalDistance).toBe(0)
      expect(empty.calories).toBe(0)
      expect(empty.splits).toEqual([])
    })
  })
})
