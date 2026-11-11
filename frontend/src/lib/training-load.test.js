import { describe, it, expect } from 'vitest'
import {
  calculateSessionLoad,
  calculateDailyLoads,
  calculateACWR,
  getRiskZone,
  sessionDate,
  RISK_ZONES,
  DEFAULT_RPE,
  DEFAULT_MINUTES_PER_SET
} from './training-load.js'

describe('calculateSessionLoad', () => {
  it('calculates sRPE session load: (durationMs / 60000) * rpe', () => {
    // 30 min @ RPE 7 = 210 AU
    expect(calculateSessionLoad({ durationMs: 1800000, rpe: 7 })).toBe(210)
    // 60 min @ RPE 8 = 480 AU
    expect(calculateSessionLoad({ durationMs: 3600000, rpe: 8 })).toBe(480)
    // 45 min @ RPE 5 = 225 AU
    expect(calculateSessionLoad({ durationMs: 2700000, rpe: 5 })).toBe(225)
  })

  it('handles fractional durations and RPE', () => {
    // 25.5 min @ RPE 7.5 = 191.25 AU
    expect(calculateSessionLoad({ durationMs: 1530000, rpe: 7.5 })).toBe(191.25)
  })

  it('calculates duration from start and end timestamps', () => {
    const start = 1731312000000
    const end = start + 45 * 60000 // 45 min
    expect(calculateSessionLoad({ start, end, rpe: 6 })).toBe(270)
  })

  it('estimates duration from set count when no clock duration exists', () => {
    // 10 completed sets * 3 min = 30 min @ RPE 7 = 210 AU
    const workout = {
      entries: [
        {
          id: '0025',
          sets: [
            { r: 8, w: 60, done: true },
            { r: 8, w: 60, done: true },
            { r: 8, w: 60, done: false } // uncompleted set ignored
          ]
        },
        {
          id: '0047',
          sets: [
            { r: 10, w: 40, done: true },
            { r: 10, w: 40, done: true }
          ]
        }
      ],
      rpe: 7
    }
    // 4 done sets * 3 min = 12 min @ RPE 7 = 84 AU
    expect(calculateSessionLoad(workout)).toBe(84)
  })

  it('supports custom minutesPerSet option', () => {
    const workout = {
      setCount: 10,
      rpe: 8
    }
    // 10 sets * 2.5 min = 25 min @ RPE 8 = 200 AU
    expect(calculateSessionLoad(workout, { minutesPerSet: 2.5 })).toBe(200)
  })

  it('derives RPE from rated sets when workout RPE is missing', () => {
    const workout = {
      durationMs: 3600000, // 60 min
      entries: [
        {
          sets: [
            { done: true, rpe: 8 },
            { done: true, rpe: 6 }
          ]
        }
      ]
    }
    // avg RPE = 7 -> 60 * 7 = 420 AU
    expect(calculateSessionLoad(workout)).toBe(420)
  })

  it('converts RIR to RPE (10 - RIR) for rated sets', () => {
    const workout = {
      durationMs: 1800000, // 30 min
      entries: [
        {
          sets: [
            { done: true, rir: 2 }, // RPE 8
            { done: true, rir: 4 }  // RPE 6
          ]
        }
      ]
    }
    // avg RPE = 7 -> 30 * 7 = 210 AU
    expect(calculateSessionLoad(workout)).toBe(210)
  })

  it('falls back to DEFAULT_RPE when sets are unrated and no RPE is provided', () => {
    const workout = {
      durationMs: 1800000 // 30 min, default RPE 6
    }
    expect(calculateSessionLoad(workout)).toBe(30 * DEFAULT_RPE)
  })

  it('supports cardio activity payload', () => {
    const cardio = {
      type: 'run',
      durationMs: 1500000, // 25 min
      distanceM: 5000,
      rpe: 8
    }
    expect(calculateSessionLoad(cardio)).toBe(200)
  })

  it('safely handles zero, negative, NaN or missing inputs without error', () => {
    expect(calculateSessionLoad(null)).toBe(0)
    expect(calculateSessionLoad(undefined)).toBe(0)
    expect(calculateSessionLoad({})).toBe(0)
    expect(calculateSessionLoad({ durationMs: 0, rpe: 7 })).toBe(0)
    expect(calculateSessionLoad({ durationMs: -1000, rpe: 7 })).toBe(0)
    expect(calculateSessionLoad({ durationMs: 1800000, rpe: 0 })).toBe(0)
    expect(calculateSessionLoad({ durationMs: 1800000, rpe: -5 })).toBe(0)
    expect(calculateSessionLoad({ durationMs: NaN, rpe: 7 })).toBe(0)
  })

  it('clamps RPE to Borg CR10 scale (1 - 10)', () => {
    // RPE 15 clamped to 10: 30 min * 10 = 300
    expect(calculateSessionLoad({ durationMs: 1800000, rpe: 15 })).toBe(300)
  })
})

describe('sessionDate', () => {
  it('extracts date from d, date, startTime, or start', () => {
    expect(sessionDate({ d: '2026-11-11' })).toBe('2026-11-11')
    expect(sessionDate({ date: '2026-11-11T12:00:00' })).toBe('2026-11-11')
    expect(sessionDate({ startTime: '2026-11-11T14:30:00.000Z' })).toBe('2026-11-11')
    expect(sessionDate({ start: new Date('2026-11-11T12:00:00').getTime() })).toBe('2026-11-11')
  })

  it('returns null for missing or invalid dates', () => {
    expect(sessionDate(null)).toBe(null)
    expect(sessionDate({})).toBe(null)
    expect(sessionDate({ startTime: 'invalid' })).toBe(null)
  })
})

describe('calculateDailyLoads', () => {
  const fixedDays = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']

  it('aggregates workouts and cardio sessions across specific days', () => {
    const workouts = [
      { d: '2026-11-08', durationMs: 3600000, rpe: 7 }, // 420 AU
      { d: '2026-11-10', durationMs: 1800000, rpe: 8 }  // 240 AU
    ]
    const cardio = [
      { startTime: '2026-11-09T08:00:00Z', durationMs: 1800000, rpe: 6 }, // 180 AU
      { startTime: '2026-11-10T18:00:00Z', durationMs: 1200000, rpe: 7 }  // 140 AU (same day as workout!)
    ]

    const daily = calculateDailyLoads(workouts, cardio, fixedDays)
    expect(daily).toHaveLength(4)

    // 2026-11-08: workout only
    expect(daily[0].date).toBe('2026-11-08')
    expect(daily[0].load).toBe(420)
    expect(daily[0].workoutLoad).toBe(420)
    expect(daily[0].cardioLoad).toBe(0)

    // 2026-11-09: cardio only
    expect(daily[1].date).toBe('2026-11-09')
    expect(daily[1].load).toBe(180)
    expect(daily[1].cardioLoad).toBe(180)

    // 2026-11-10: combined workout + cardio on same day
    expect(daily[2].date).toBe('2026-11-10')
    expect(daily[2].load).toBe(380) // 240 + 140
    expect(daily[2].workoutLoad).toBe(240)
    expect(daily[2].cardioLoad).toBe(140)

    // 2026-11-11: rest day (0 load)
    expect(daily[3].date).toBe('2026-11-11')
    expect(daily[3].load).toBe(0)

    // Helpers
    expect(daily.totalLoad).toBe(420 + 180 + 380)
    expect(daily.byDate['2026-11-10'].load).toBe(380)
    expect(Number(daily[0])).toBe(420)
  })

  it('defaults to 28 days ending on specified or current date', () => {
    const daily = calculateDailyLoads([], [], { days: 28, endDate: '2026-11-28' })
    expect(daily).toHaveLength(28)
    expect(daily[27].date).toBe('2026-11-28')
    expect(daily[0].date).toBe('2026-11-01')
    expect(daily.every(d => d.load === 0)).toBe(true)
  })

  it('safely handles empty or null workouts and cardio activities', () => {
    const daily = calculateDailyLoads(null, null, 7)
    expect(daily).toHaveLength(7)
    expect(daily.every(d => d.load === 0)).toBe(true)
  })
})

describe('getRiskZone', () => {
  it('classifies ACWR into correct risk zones per Gabbett 2016', () => {
    expect(getRiskZone(0)).toBe(RISK_ZONES.UNDERTRAINING)
    expect(getRiskZone(0.79)).toBe(RISK_ZONES.UNDERTRAINING)
    expect(getRiskZone(0.8)).toBe(RISK_ZONES.OPTIMAL)
    expect(getRiskZone(1.0)).toBe(RISK_ZONES.OPTIMAL)
    expect(getRiskZone(1.3)).toBe(RISK_ZONES.OPTIMAL)
    expect(getRiskZone(1.31)).toBe(RISK_ZONES.CAUTION)
    expect(getRiskZone(1.45)).toBe(RISK_ZONES.CAUTION)
    expect(getRiskZone(1.5)).toBe(RISK_ZONES.CAUTION)
    expect(getRiskZone(1.51)).toBe(RISK_ZONES.DANGER)
    expect(getRiskZone(2.0)).toBe(RISK_ZONES.DANGER)
  })

  it('handles null, undefined, NaN, Infinity safely without crashing', () => {
    expect(getRiskZone(null)).toBe(RISK_ZONES.UNDERTRAINING)
    expect(getRiskZone(undefined)).toBe(RISK_ZONES.UNDERTRAINING)
    expect(getRiskZone(NaN)).toBe(RISK_ZONES.UNDERTRAINING)
    expect(getRiskZone(Infinity)).toBe(RISK_ZONES.UNDERTRAINING)
  })
})

describe('calculateACWR', () => {
  it('returns ACWR 1.0 (optimal) for steady constant workload', () => {
    // 28 days of constant 100 AU daily load
    const steadyLoads = new Array(28).fill(100)
    const res = calculateACWR(steadyLoads)

    expect(res.acwr).toBe(1.0)
    expect(res.acuteLoad).toBe(100)
    expect(res.chronicLoad).toBe(100)
    expect(res.acuteTotal).toBe(700)
    expect(res.chronicTotal).toBe(2800)
    expect(res.riskZone).toBe('optimal')
    expect(res.zone).toBe('optimal')
  })

  it('detects undertraining zone (< 0.8) during taper or drop in load', () => {
    // 21 days of 100 AU, then acute week drops to 20 AU
    const taperLoads = [...new Array(21).fill(100), ...new Array(7).fill(20)]
    const res = calculateACWR(taperLoads)

    // Acute: 20/day
    // Chronic: (21 * 100 + 7 * 20) / 28 = 2240 / 28 = 80/day
    // ACWR: 20 / 80 = 0.25
    expect(res.acuteLoad).toBe(20)
    expect(res.chronicLoad).toBe(80)
    expect(res.acwr).toBe(0.25)
    expect(res.riskZone).toBe('undertraining')
  })

  it('detects caution zone (1.3 - 1.5) on moderate workload ramp', () => {
    // 21 days of 100 AU, then acute week increases to 175 AU
    const rampLoads = [...new Array(21).fill(100), ...new Array(7).fill(175)]
    const res = calculateACWR(rampLoads)

    // Acute: 175/day
    // Chronic: (21 * 100 + 7 * 175) / 28 = 3325 / 28 = 118.75/day
    // ACWR: 175 / 118.75 = 1.47
    expect(res.acwr).toBe(1.47)
    expect(res.riskZone).toBe('caution')
  })

  it('detects danger zone (> 1.5) on sudden acute workload spike', () => {
    // 21 days of 100 AU, then acute week jumps to 250 AU
    const spikeLoads = [...new Array(21).fill(100), ...new Array(7).fill(250)]
    const res = calculateACWR(spikeLoads)

    // Acute: 250/day
    // Chronic: (21 * 100 + 7 * 250) / 28 = 3850 / 28 = 137.5/day
    // ACWR: 250 / 137.5 = 1.82
    expect(res.acwr).toBe(1.82)
    expect(res.riskZone).toBe('danger')
  })

  it('supports EWMA (exponentially weighted moving average) method', () => {
    const steadyLoads = new Array(28).fill(100)
    const res = calculateACWR(steadyLoads, { method: 'ewma' })

    expect(res.method).toBe('ewma')
    expect(res.acwr).toBe(1.0)
    expect(res.riskZone).toBe('optimal')
  })

  it('accepts array of daily load objects from calculateDailyLoads', () => {
    const dailyObjects = new Array(28).fill(null).map((_, i) => ({
      date: `2026-11-${String(i + 1).padStart(2, '0')}`,
      load: 120
    }))
    const res = calculateACWR(dailyObjects)
    expect(res.acwr).toBe(1.0)
    expect(res.riskZone).toBe('optimal')
  })

  it('handles empty history safely without NaN or Infinity', () => {
    const emptyRes = calculateACWR([])
    expect(emptyRes.acwr).toBe(0)
    expect(emptyRes.acuteLoad).toBe(0)
    expect(emptyRes.chronicLoad).toBe(0)
    expect(emptyRes.riskZone).toBe('undertraining')
    expect(Number.isNaN(emptyRes.acwr)).toBe(false)
    expect(Number.isFinite(emptyRes.acwr)).toBe(true)
  })

  it('handles all-zero history safely without NaN or Infinity', () => {
    const zeroLoads = new Array(28).fill(0)
    const res = calculateACWR(zeroLoads)
    expect(res.acwr).toBe(0)
    expect(res.riskZone).toBe('undertraining')
    expect(Number.isNaN(res.acwr)).toBe(false)
    expect(Number.isFinite(res.acwr)).toBe(true)
  })

  it('handles acute load with zero chronic baseline safely without Infinity', () => {
    // Edge case: someone passes acute days only without chronic baseline
    const acuteOnly = [100, 100, 100, 100, 100, 100, 100]
    const res = calculateACWR(acuteOnly)
    expect(Number.isFinite(res.acwr)).toBe(true)
    expect(res.acwr).toBeGreaterThan(0)
    expect(Number.isNaN(res.acwr)).toBe(false)
  })

  it('implements valueOf() allowing direct numeric coercion and comparison', () => {
    const res = calculateACWR(new Array(28).fill(100))
    expect(Number(res)).toBe(1.0)
    expect(res + 0.5).toBe(1.5)
  })
})
