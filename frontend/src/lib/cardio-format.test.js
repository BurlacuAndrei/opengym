import { describe, it, expect } from 'vitest'
import {
  METERS_PER_KM,
  METERS_PER_MILE,
  METERS_PER_FOOT,
  SPLIT_DIST_METRIC,
  SPLIT_DIST_IMPERIAL,
  SPLIT_DISTANCE,
  CARDIO_UNITS,
  isImperial,
  isMetric,
  cardioUnits,
  getCardioUnits,
  distanceUnit,
  paceUnit,
  speedUnit,
  elevationUnit,
  splitDistance,
  defaultRateMetric,
  rateMetricFor,
  metersToKm,
  kmToMeters,
  metersToMiles,
  milesToMeters,
  convertDistance,
  metersToFeet,
  feetToMeters,
  convertElevation,
  kmhToMph,
  mphToKmh,
  convertSpeed,
  hasDist,
  paceOf,
  paceFromSeconds,
  speedOf,
  speedFromSeconds,
  splitOf,
  formatPaceTime,
  formatPace,
  fmtPace,
  formatSpeed,
  fmtSpeed,
  formatElevation,
  fmtElevation,
  formatDistance,
  fmtDist,
  formatSplitTime,
  formatRate,
} from './cardio-format.js'

describe('Cardio Units & System Resolution', () => {
  it('maps "kg" profile unit to metric units', () => {
    expect(isMetric('kg')).toBe(true)
    expect(isImperial('kg')).toBe(false)
    expect(distanceUnit('kg')).toBe('km')
    expect(paceUnit('kg')).toBe('min/km')
    expect(speedUnit('kg')).toBe('km/h')
    expect(elevationUnit('kg')).toBe('m')
    expect(splitDistance('kg')).toBe(1000)
    expect(SPLIT_DISTANCE.kg).toBe(1000)

    const units = cardioUnits('kg')
    expect(units.dist).toBe('km')
    expect(units.pace).toBe('min/km')
    expect(units.speed).toBe('km/h')
    expect(units.elevation).toBe('m')
    expect(units.splitDistance).toBe(1000)
  })

  it('maps "lbs" profile unit to imperial units', () => {
    expect(isMetric('lbs')).toBe(false)
    expect(isImperial('lbs')).toBe(true)
    expect(distanceUnit('lbs')).toBe('mi')
    expect(paceUnit('lbs')).toBe('min/mi')
    expect(speedUnit('lbs')).toBe('mph')
    expect(elevationUnit('lbs')).toBe('ft')
    expect(splitDistance('lbs')).toBe(1609.344)
    expect(SPLIT_DISTANCE.lbs).toBe(1609.344)

    const units = cardioUnits('lbs')
    expect(units.dist).toBe('mi')
    expect(units.pace).toBe('min/mi')
    expect(units.speed).toBe('mph')
    expect(units.elevation).toBe('ft')
    expect(units.splitDistance).toBe(1609.344)
  })

  it('defaults to metric when unit is omitted or unrecognized', () => {
    expect(distanceUnit()).toBe('km')
    expect(paceUnit()).toBe('min/km')
    expect(speedUnit()).toBe('km/h')
    expect(elevationUnit()).toBe('m')
    expect(splitDistance()).toBe(1000)
    expect(cardioUnits()).toEqual(CARDIO_UNITS.kg)
  })
})

describe('Activity Rate Metric Preference', () => {
  it('defaults "run", "hike", and "walk" to pace', () => {
    expect(defaultRateMetric('run')).toBe('pace')
    expect(defaultRateMetric('hike')).toBe('pace')
    expect(defaultRateMetric('walk')).toBe('pace')
    expect(defaultRateMetric('RUN')).toBe('pace')
    expect(defaultRateMetric('running')).toBe('pace')
    expect(defaultRateMetric('walking')).toBe('pace')
    expect(defaultRateMetric('hiking')).toBe('pace')
    expect(rateMetricFor('run')).toBe('pace')
  })

  it('defaults "ride" to speed', () => {
    expect(defaultRateMetric('ride')).toBe('speed')
    expect(defaultRateMetric('RIDE')).toBe('speed')
    expect(defaultRateMetric('bike')).toBe('speed')
    expect(defaultRateMetric('cycling')).toBe('speed')
    expect(rateMetricFor('ride')).toBe('speed')
  })

  it('defaults unknown or empty activity to pace', () => {
    expect(defaultRateMetric('')).toBe('pace')
    expect(defaultRateMetric(null)).toBe('pace')
    expect(defaultRateMetric(undefined)).toBe('pace')
    expect(defaultRateMetric('unknown_activity')).toBe('pace')
  })
})

describe('Unit Conversions', () => {
  it('converts meters to km and back', () => {
    expect(metersToKm(5000)).toBe(5)
    expect(kmToMeters(5)).toBe(5000)
    expect(metersToKm(0)).toBe(0)
    expect(metersToKm(null)).toBe(0)
  })

  it('converts meters to miles and back using 1609.344m', () => {
    expect(metersToMiles(1609.344)).toBe(1)
    expect(milesToMeters(1)).toBe(1609.344)
    expect(metersToMiles(0)).toBe(0)
    expect(metersToMiles(null)).toBe(0)
  })

  it('converts elevation between meters and feet (0.3048m / ft)', () => {
    expect(metersToFeet(304.8)).toBeCloseTo(1000, 4)
    expect(feetToMeters(1000)).toBeCloseTo(304.8, 4)
    expect(convertElevation(100, 'kg')).toBe(100)
    expect(convertElevation(100, 'lbs')).toBeCloseTo(328.084, 1)
  })

  it('converts speed between km/h and mph', () => {
    expect(kmhToMph(10)).toBeCloseTo(6.2137, 3)
    expect(mphToKmh(6.2137119)).toBeCloseTo(10, 3)
    expect(convertSpeed(10, 'kg')).toBe(10)
    expect(convertSpeed(10, 'lbs')).toBeCloseTo(6.2137, 3)
  })
})

describe('Pace Calculation (paceOf)', () => {
  it('calculates pace in min/km for metric', () => {
    // 5 km in 25 min -> 5.0 min/km
    expect(paceOf(25, 5000, 'kg')).toBe(5)
    // 10 km in 55 min -> 5.5 min/km
    expect(paceOf(55, 10000, 'kg')).toBe(5.5)
  })

  it('calculates pace in min/mi for imperial', () => {
    // 1 mile (1609.344m) in 8 minutes -> 8.0 min/mi
    expect(paceOf(8, 1609.344, 'lbs')).toBe(8)
    // 3.1 miles in 24.8 minutes -> 8.0 min/mi
    expect(paceOf(24.8, 1609.344 * 3.1, 'lbs')).toBeCloseTo(8, 4)
  })

  it('calculates pace from seconds', () => {
    expect(paceFromSeconds(1500, 5000, 'kg')).toBe(5)
  })

  it('handles zero, null, negative, NaN duration and distance gracefully', () => {
    expect(paceOf(0, 5000)).toBeNull()
    expect(paceOf(25, 0)).toBeNull()
    expect(paceOf(null, 5000)).toBeNull()
    expect(paceOf(25, null)).toBeNull()
    expect(paceOf(-10, 5000)).toBeNull()
    expect(paceOf(25, -5000)).toBeNull()
    expect(paceOf('abc', 5000)).toBeNull()
    expect(paceOf(25, 'xyz')).toBeNull()
    expect(paceFromSeconds(0, 5000)).toBeNull()
  })
})

describe('Speed Calculation (speedOf)', () => {
  it('calculates speed in km/h for metric', () => {
    // 5 km in 30 min -> 10 km/h
    expect(speedOf(30, 5000, 'kg')).toBe(10)
    // 20 km in 60 min -> 20 km/h
    expect(speedOf(60, 20000, 'kg')).toBe(20)
  })

  it('calculates speed in mph for imperial', () => {
    // 1 mile in 6 min -> 10 mph
    expect(speedOf(6, 1609.344, 'lbs')).toBe(10)
  })

  it('calculates speed from seconds', () => {
    expect(speedFromSeconds(1800, 5000, 'kg')).toBe(10)
  })

  it('handles zero, null, negative, NaN duration and distance gracefully', () => {
    expect(speedOf(0, 5000)).toBeNull()
    expect(speedOf(30, 0)).toBeNull()
    expect(speedOf(null, 5000)).toBeNull()
    expect(speedOf(30, null)).toBeNull()
    expect(speedOf(-30, 5000)).toBeNull()
    expect(speedOf(30, -5000)).toBeNull()
    expect(speedOf('invalid', 5000)).toBeNull()
    expect(speedFromSeconds(0, 5000)).toBeNull()
  })
})

describe('Split Calculation (splitOf)', () => {
  it('calculates 1000m metric split in seconds', () => {
    // 5000m in 25 min -> 1000m split is 5 min = 300 seconds
    expect(splitOf(25, 5000, 'kg')).toBe(300)
    expect(splitOf(25, 5000, 1000)).toBe(300)
  })

  it('calculates 1609.344m imperial split in seconds', () => {
    // 2 miles in 16 min -> 1 mile split is 8 min = 480 seconds
    expect(splitOf(16, 1609.344 * 2, 'lbs')).toBe(480)
  })

  it('calculates rowing 500m split in seconds', () => {
    // 2000m row in 8 min -> 500m split is 2 min = 120 seconds
    expect(splitOf(8, 2000, 500)).toBe(120)
  })

  it('handles edge cases', () => {
    expect(splitOf(0, 5000)).toBeNull()
    expect(splitOf(25, 0)).toBeNull()
    expect(splitOf(null, null)).toBeNull()
  })
})

describe('Formatting Functions', () => {
  describe('formatPaceTime', () => {
    it('formats minutes into m:ss', () => {
      expect(formatPaceTime(5.5)).toBe('5:30')
      expect(formatPaceTime(5)).toBe('5:00')
      expect(formatPaceTime(4.25)).toBe('4:15')
    })

    it('avoids rollover bug where seconds round to 60 (e.g. 5:60)', () => {
      // 5 + 59.8/60 min ≈ 5.9967 min should round to 6:00, never 5:60
      expect(formatPaceTime(5.999)).toBe('6:00')
    })

    it('returns empty string for null, 0, or negative', () => {
      expect(formatPaceTime(0)).toBe('')
      expect(formatPaceTime(null)).toBe('')
      expect(formatPaceTime(-5)).toBe('')
    })
  })

  describe('formatPace / fmtPace', () => {
    it('formats pace with metric unit', () => {
      expect(formatPace(5.5, 'kg')).toBe('5:30 min/km')
      expect(fmtPace(5.5, 'kg')).toBe('5:30 min/km')
    })

    it('formats pace with imperial unit', () => {
      expect(formatPace(8.5, 'lbs')).toBe('8:30 min/mi')
      expect(fmtPace(8.5, 'lbs')).toBe('8:30 min/mi')
    })

    it('supports short pace format (/km, /mi)', () => {
      expect(fmtPace(5.5, 'kg', { short: true })).toBe('5:30 /km')
      expect(fmtPace(8.5, 'lbs', { short: true })).toBe('8:30 /mi')
    })

    it('returns empty string on empty or invalid pace', () => {
      expect(formatPace(null)).toBe('')
      expect(fmtPace(null)).toBe('')
      expect(formatPace(0)).toBe('')
    })
  })

  describe('formatSpeed / fmtSpeed', () => {
    it('formats speed with metric unit', () => {
      expect(formatSpeed(10, 'kg')).toBe('10 km/h')
      expect(fmtSpeed(10.5, 'kg')).toBe('10.5 km/h')
    })

    it('formats speed with imperial unit', () => {
      expect(formatSpeed(6.2, 'lbs')).toBe('6.2 mph')
      expect(fmtSpeed(12, 'lbs')).toBe('12 mph')
    })

    it('handles zero and nulls', () => {
      expect(formatSpeed(0, 'kg')).toBe('0 km/h')
      expect(formatSpeed(null, 'kg')).toBe('')
      expect(formatSpeed('', 'kg')).toBe('')
    })
  })

  describe('formatElevation / fmtElevation', () => {
    it('formats elevation in meters for metric', () => {
      expect(formatElevation(150, 'kg')).toBe('150 m')
      expect(fmtElevation(0, 'kg')).toBe('0 m')
    })

    it('formats elevation in feet for imperial', () => {
      // 100 meters ≈ 328 feet
      expect(formatElevation(100, 'lbs')).toBe('328 ft')
    })

    it('handles negative elevation (below sea level)', () => {
      expect(formatElevation(-10, 'kg')).toBe('-10 m')
    })

    it('returns empty string for null or invalid', () => {
      expect(formatElevation(null)).toBe('')
      expect(formatElevation(undefined)).toBe('')
    })
  })

  describe('formatDistance and fmtDist', () => {
    it('formatDistance formats km for metric and mi for imperial', () => {
      expect(formatDistance(5000, 'kg')).toBe('5 km')
      expect(formatDistance(1609.344, 'lbs')).toBe('1 mi')
      expect(formatDistance(0, 'kg')).toBe('0 km')
      expect(formatDistance(null, 'lbs')).toBe('0 mi')
    })

    it('fmtDist shows m below 1000m for metric, km above', () => {
      expect(fmtDist(400, 'kg')).toBe('400 m')
      expect(fmtDist(5000, 'kg')).toBe('5 km')
      expect(fmtDist(0, 'kg')).toBe('0 m')
    })

    it('fmtDist shows mi for imperial', () => {
      expect(fmtDist(1609.344 * 3.1, 'lbs')).toBe('3.1 mi')
      expect(fmtDist(0, 'lbs')).toBe('0 mi')
    })
  })

  describe('formatSplitTime', () => {
    it('formats seconds into m:ss', () => {
      expect(formatSplitTime(120)).toBe('2:00')
      expect(formatSplitTime(135)).toBe('2:15')
      expect(formatSplitTime(0)).toBe('')
      expect(formatSplitTime(null)).toBe('')
    })
  })

  describe('formatRate', () => {
    it('formats pace by default for running', () => {
      const res = formatRate({ min: 25, dist: 5000, activity: 'run', unit: 'kg' })
      expect(res).toBe('5:00 min/km')
    })

    it('formats speed by default for cycling / ride', () => {
      const res = formatRate({ min: 30, dist: 10000, activity: 'ride', unit: 'kg' })
      expect(res).toBe('20 km/h')
    })

    it('respects explicit metric override', () => {
      const res = formatRate({ min: 30, dist: 10000, activity: 'ride', unit: 'kg', metric: 'pace' })
      expect(res).toBe('3:00 min/km')
    })
  })

  describe('hasDist helper', () => {
    it('returns true when dist > 0', () => {
      expect(hasDist({ dist: 5000 })).toBe(true)
      expect(hasDist({ dist: '5000' })).toBe(true)
      expect(hasDist({ dist: 0 })).toBe(false)
      expect(hasDist({})).toBe(false)
      expect(hasDist(null)).toBe(false)
    })
  })
})
