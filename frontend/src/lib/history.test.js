import { describe, it, expect } from 'vitest'
import { modeOf, isTimed, fmtSec, setLabel, defaultConfig, buildSets, exLine, workoutVolume, effortOf, stepEffort, capEffort, unifiedHistory, getUnifiedHistory, groupHistoryByDate, streakWeeks, effectiveRoutineId, effectiveDaySessions } from './history.js'
import { EXDB } from './exercises.js'

// Real ids out of the shipped catalogue, so the body-part fallback is exercised for real.
const CARDIO = EXDB.find(e => e.bp === 'cardio').id
const LIFT = EXDB.find(e => e.bp !== 'cardio').id

describe('modeOf', () => {
  it('falls back to the body part when a plan has no mode — every existing plan keeps working', () => {
    expect(modeOf({ id: CARDIO })).toBe('cardio')
    expect(modeOf({ id: LIFT })).toBe('reps')
    expect(modeOf({ id: 'no-such-exercise' })).toBe('reps')
    expect(modeOf({})).toBe('reps')
    expect(modeOf(null)).toBe('reps')
    expect(modeOf(undefined)).toBe('reps')
  })

  it('lets an explicit mode win over the body part', () => {
    expect(modeOf({ id: LIFT, mode: 'time' })).toBe('time')
    expect(modeOf({ id: CARDIO, mode: 'reps' })).toBe('reps')
    expect(modeOf({ id: CARDIO, mode: 'time' })).toBe('time')
  })

  it('ignores a mode it does not know rather than trusting a bad file', () => {
    expect(modeOf({ id: LIFT, mode: 'nonsense' })).toBe('reps')
    expect(modeOf({ id: CARDIO, mode: '' })).toBe('cardio')
  })

  it('exposes the timed check', () => {
    expect(isTimed({ id: LIFT, mode: 'time' })).toBe(true)
    expect(isTimed({ id: LIFT })).toBe(false)
  })
})

describe('fmtSec', () => {
  it('reads as a clock, not a pile of seconds', () => {
    expect(fmtSec(0)).toBe('0:00')
    expect(fmtSec(9)).toBe('0:09')
    expect(fmtSec(45)).toBe('0:45')
    expect(fmtSec(60)).toBe('1:00')
    expect(fmtSec(90)).toBe('1:30')
    expect(fmtSec(605)).toBe('10:05')
  })
  it('is defensive about junk input', () => {
    expect(fmtSec(-5)).toBe('0:00')
    expect(fmtSec(undefined)).toBe('0:00')
    expect(fmtSec(null)).toBe('0:00')
    expect(fmtSec(NaN)).toBe('0:00')
    expect(fmtSec(44.6)).toBe('0:45')
  })
})

describe('setLabel', () => {
  it('describes each mode in its own terms', () => {
    expect(setLabel(LIFT, { w: 60, r: 10 })).toBe('60×10')
    expect(setLabel(CARDIO, { min: 20, speed: 9 })).toBe('20 min @ 9 km/h')
    expect(setLabel(LIFT, { sec: 45, w: 0 }, { mode: 'time' })).toBe('0:45')
    expect(setLabel(LIFT, { sec: 90, w: 20 }, { mode: 'time' })).toBe('1:30 · 20')
  })

  it('reads a legacy set with no config exactly as before', () => {
    expect(setLabel(LIFT, { w: 0, r: 0 })).toBe('0×0')
    expect(setLabel(CARDIO, {})).toBe('0 min @ 0 km/h')
  })

  it('appends RIR when present, including a valid 0', () => {
    expect(setLabel(LIFT, { w: 60, r: 10, rir: 2 })).toBe('60×10 (RIR 2)')
    expect(setLabel(LIFT, { w: 60, r: 10, rir: 1.5 })).toBe('60×10 (RIR 1.5)')
    expect(setLabel(LIFT, { w: 60, r: 10, rir: 0 })).toBe('60×10 (RIR 0)')
  })

  it('says nothing about RIR on a set that never logged one', () => {
    expect(setLabel(LIFT, { w: 60, r: 10 })).toBe('60×10')
    // cleared in the UI: the key is dropped, but a null must read the same as absent
    expect(setLabel(LIFT, { w: 60, r: 10, rir: null })).toBe('60×10')
  })

  it('appends RPE for a set logged on that scale', () => {
    expect(setLabel(LIFT, { w: 60, r: 10, rpe: 8 })).toBe('60×10 (RPE 8)')
    expect(setLabel(LIFT, { w: 60, r: 10, rpe: 9.5 })).toBe('60×10 (RPE 9.5)')
    expect(setLabel(LIFT, { w: 60, r: 10, rpe: null })).toBe('60×10')
  })

  it('keeps each set on the scale it was logged with', () => {
    // switching the setting must not rewrite history: an old RIR set still reads as RIR
    expect(setLabel(LIFT, { w: 60, r: 10, rir: 2 })).toBe('60×10 (RIR 2)')
    // and a set that somehow carries both is described once, by the one it was logged with
    expect(setLabel(LIFT, { w: 60, r: 10, rir: 2, rpe: 8 })).toBe('60×10 (RIR 2)')
  })
})

describe('effortOf', () => {
  it('reads the scale a profile logs', () => {
    expect(effortOf({ effort: 'rpe' })).toBe('rpe')
    expect(effortOf({ effort: 'rir' })).toBe('rir')
    expect(effortOf({ effort: 'none' })).toBe('none')
    expect(effortOf({})).toBe('none')
  })

  it('keeps the column for a profile still carrying the old showRir flag', () => {
    expect(effortOf({ showRir: true })).toBe('rir')
    // what a stored profile actually looks like once it is overlaid on DEF
    expect(effortOf({ effort: null, showRir: true })).toBe('rir')
    expect(effortOf({ effort: null })).toBe('none')
    expect(effortOf({ showRir: false })).toBe('none')
    // once the new setting is chosen it wins, whatever the old flag said
    expect(effortOf({ showRir: true, effort: 'rpe' })).toBe('rpe')
    expect(effortOf({ showRir: true, effort: 'none' })).toBe('none')
  })

  // The store cannot be imported here (it reaches for `navigator` at module load), so the
  // overlay it performs is reproduced literally: stored profile spread over the defaults.
  // DEF.effort is null precisely so this lands on the showRir fallback rather than on 'none'.
  const overlay = stored => ({ unit: 'kg', effort: null, ...stored })

  it('survives the overlay every load path performs', () => {
    // upgrading with the column on: local state, a server pull and a restored backup all
    // arrive as a stored object spread over the defaults, and all must keep the column
    expect(effortOf(overlay({ showRir: true }))).toBe('rir')
    expect(effortOf(overlay({ showRir: false }))).toBe('none')
    // a profile predating the RIR feature entirely
    expect(effortOf(overlay({}))).toBe('none')
    // and one written by this version
    expect(effortOf(overlay({ effort: 'rpe' }))).toBe('rpe')
    // an old backup restored over a profile that had already chosen: the file wins, because
    // an import replaces state wholesale rather than merging
    expect(effortOf(overlay({ showRir: true, effort: undefined }))).toBe('rir')
  })

  it('is not fooled by a junk value', () => {
    expect(effortOf({ effort: 'rpe10' })).toBe('none')
    expect(effortOf({ effort: 'RIR' })).toBe('none')
    expect(effortOf({ effort: 'f' })).toBe('none')
    expect(effortOf(null)).toBe('none')
    expect(effortOf(undefined)).toBe('none')
    // a junk value with the old flag still set falls back rather than showing nothing
    expect(effortOf({ effort: 'nope', showRir: true })).toBe('rir')
  })
})

describe('stepEffort', () => {
  it('starts at the bottom of the scale and walks up', () => {
    // the first + on an empty cell lands on the lowest value, not on some "typical" middle:
    // the stepper counts up from the floor the way every other stepper in the app does
    expect(stepEffort('rir', null, 1)).toBe(0)
    expect(stepEffort('rpe', null, 1)).toBe(6)
    // and then in even steps
    expect(stepEffort('rir', 0, 1)).toBe(0.5)
    expect(stepEffort('rir', 0.5, 1)).toBe(1)
    expect(stepEffort('rpe', 6, 1)).toBe(6.5)
  })

  it('leaves an untouched cell unlogged when stepped down', () => {
    // one stray − on a fresh row must not stamp "(RIR 0)" — went to failure — on the set
    expect(stepEffort('rir', null, -1)).toBe(null)
    expect(stepEffort('rpe', null, -1)).toBe(null)
    expect(stepEffort('rir', undefined, -1)).toBe(null)
  })

  it('clears the cell again when stepped back off the floor', () => {
    // so a mistap is undoable rather than sticking at the floor for good
    expect(stepEffort('rir', 0, -1)).toBe(null)
    expect(stepEffort('rpe', 6, -1)).toBe(null)
    // but a step that stays inside the scale is an ordinary step
    expect(stepEffort('rir', 0.5, -1)).toBe(0)
    expect(stepEffort('rpe', 6.5, -1)).toBe(6)
  })

  it('stops at the top of the scale', () => {
    expect(stepEffort('rir', 9.5, 1)).toBe(10)
    expect(stepEffort('rir', 10, 1)).toBe(10)
    expect(stepEffort('rpe', 10, 1)).toBe(10)
  })

  it('keeps halves clean instead of drifting into float dust', () => {
    let v = null
    for (let i = 0; i < 6; i++) v = stepEffort('rpe', v, 1)
    expect(v).toBe(8.5)
    expect(stepEffort('rir', 0.1 + 0.2, 1)).toBe(0.8)
  })

  it('steps evenly from a value typed below the floor rather than snapping', () => {
    // nothing stops someone typing RPE 3; the stepper must not jump them to 6 on one tap
    expect(stepEffort('rpe', 3, 1)).toBe(3.5)
    // stepping down out of the scale from there just clears it
    expect(stepEffort('rpe', 3, -1)).toBe(null)
  })

  it('does nothing when the profile logs no effort at all', () => {
    expect(stepEffort('none', null, 1)).toBe(null)
    expect(stepEffort('none', 2, 1)).toBe(2)
    expect(stepEffort(undefined, 2, -1)).toBe(2)
  })
})

describe('capEffort', () => {
  it('caps a typed value at the top of the scale', () => {
    expect(capEffort('rir', 12)).toBe(10)
    expect(capEffort('rpe', 99)).toBe(10)
    expect(capEffort('rpe', 8)).toBe(8)
  })

  it('does not floor a typed value, so typing "10" survives its first keystroke', () => {
    // clamping up would turn the "1" of "10" into 6 and fight the input
    expect(capEffort('rpe', 1)).toBe(1)
    expect(capEffort('rir', 0)).toBe(0)
  })

  it('passes an emptied field through untouched', () => {
    expect(capEffort('rir', null)).toBe(null)
    expect(capEffort('rpe', undefined)).toBe(undefined)
    expect(capEffort('none', 12)).toBe(12)
  })
})

// End-to-end on the data, not the pixels: what a set carries after the taps a real session
// makes, and what it reads back as afterwards.
describe('logging effort across a session', () => {
  it('logs a working set on the chosen scale', () => {
    // four + taps from empty on an RPE profile: 6, 6.5, 7, 7.5
    let v = null
    for (let i = 0; i < 4; i++) v = stepEffort('rpe', v, 1)
    expect(setLabel(LIFT, { w: 80, r: 5, rpe: v })).toBe('80×5 (RPE 7.5)')
  })

  it('a set taken to failure is logged, not left blank', () => {
    const v = stepEffort('rir', null, 1)      // one + on an RIR profile
    expect(v).toBe(0)
    expect(setLabel(LIFT, { w: 100, r: 3, rir: v })).toBe('100×3 (RIR 0)')
  })

  it('switching the setting mid-history rewrites nothing', () => {
    const old = { w: 60, r: 10, rir: 2 }      // logged while the profile was on RIR
    const fresh = { w: 60, r: 10, rpe: 8 }    // logged after switching to RPE
    expect(effortOf({ effort: 'rpe' })).toBe('rpe')
    expect(setLabel(LIFT, old)).toBe('60×10 (RIR 2)')
    expect(setLabel(LIFT, fresh)).toBe('60×10 (RPE 8)')
    // turning the column off entirely hides the control but keeps both sets readable
    expect(effortOf({ effort: 'none' })).toBe('none')
    expect(setLabel(LIFT, old)).toBe('60×10 (RIR 2)')
  })

  it('never attaches effort to a mode that has no place for it', () => {
    // cardio and timed sets have no third stepper, and their labels ignore the field even
    // if an import or an old file put one there
    expect(setLabel(CARDIO, { min: 20, speed: 9, rpe: 8 })).toBe('20 min @ 9 km/h')
    expect(setLabel(LIFT, { sec: 45, rir: 2 }, { id: LIFT, mode: 'time' })).toBe('0:45')
  })
})

describe('defaultConfig', () => {
  it('gives each mode a sensible starting point', () => {
    expect(defaultConfig(LIFT)).toEqual({ sets: 3, reps: 10, weight: 0, mode: 'reps' })
    expect(defaultConfig(CARDIO)).toEqual({ sets: 1, min: 20, speed: 8 })
    expect(defaultConfig(LIFT, 'time')).toEqual({ sets: 3, sec: 45, weight: 0, mode: 'time' })
  })
})

describe('exLine', () => {
  it('summarises a planned exercise per mode', () => {
    expect(exLine({ id: LIFT, sets: 3, reps: 10 }, 'kg')).toBe('3 × 10')
    expect(exLine({ id: LIFT, sets: 3, reps: 10, weight: 60 }, 'kg')).toBe('3 × 10 · 60 kg')
    expect(exLine({ id: LIFT, sets: 3, sec: 45, mode: 'time' }, 'kg')).toBe('3 × 0:45')
    expect(exLine({ id: LIFT, sets: 2, sec: 90, weight: 20, mode: 'time' }, 'kg')).toBe('2 × 1:30 · 20 kg')
    expect(exLine({ id: CARDIO, sets: 1, min: 20, speed: 8 }, 'kg')).toBe('1 × 20 min @ 8 km/h')
  })
})

const emptyS = { workouts: [], exWeights: {} }

describe('buildSets', () => {
  it('builds reps sets from the plan when there is no history', () => {
    expect(buildSets(emptyS, { id: LIFT, sets: 3, reps: 8, weight: 50 }))
      .toEqual([{ w: 50, r: 8, done: false }, { w: 50, r: 8, done: false }, { w: 50, r: 8, done: false }])
  })

  it('builds timed sets, carrying the planned duration and load', () => {
    expect(buildSets(emptyS, { id: LIFT, mode: 'time', sets: 2, sec: 60, weight: 20 }))
      .toEqual([{ sec: 60, w: 20, done: false }, { sec: 60, w: 20, done: false }])
  })

  it('builds cardio sets unchanged', () => {
    expect(buildSets(emptyS, { id: CARDIO, sets: 1, min: 25, speed: 9 }))
      .toEqual([{ min: 25, speed: 9, done: false }])
  })

  it('carries last time\'s numbers forward within the same mode', () => {
    const S = { exWeights: {}, workouts: [{ d: '2026-01-01', entries: [{ id: LIFT, target: { mode: 'time' }, sets: [{ sec: 70, w: 10, done: true }] }] }] }
    expect(buildSets(S, { id: LIFT, mode: 'time', sets: 2, sec: 45, weight: 0 }))
      .toEqual([{ sec: 70, w: 10, done: false }, { sec: 70, w: 10, done: false }])
  })

  it('does not seed a duration from a rep count when an exercise switches to time', () => {
    const S = { exWeights: {}, workouts: [{ d: '2026-01-01', entries: [{ id: LIFT, sets: [{ w: 60, r: 10, done: true }] }] }] }
    expect(buildSets(S, { id: LIFT, mode: 'time', sets: 1, sec: 45, weight: 0 }))
      .toEqual([{ sec: 45, w: 0, done: false }])
  })

  it('does not seed reps from a timed set when an exercise switches back', () => {
    const S = { exWeights: {}, workouts: [{ d: '2026-01-01', entries: [{ id: LIFT, target: { mode: 'time' }, sets: [{ sec: 70, w: 10, done: true }] }] }] }
    expect(buildSets(S, { id: LIFT, mode: 'reps', sets: 1, reps: 8, weight: 40 }))
      .toEqual([{ w: 40, r: 8, done: false }])
  })

  it('still prefers the confirmed working weight for reps sets', () => {
    const S = { exWeights: { [LIFT]: { w: 75 } }, workouts: [{ d: '2026-01-01', entries: [{ id: LIFT, sets: [{ w: 60, r: 10, done: true }] }] }] }
    expect(buildSets(S, { id: LIFT, sets: 1, reps: 8, weight: 50 })).toEqual([{ w: 75, r: 10, done: false }])
  })
})

describe('workoutVolume', () => {
  it('counts reps work and leaves timed/cardio sets out — there is no weight × reps for a hold', () => {
    const w = { entries: [
      { id: LIFT, sets: [{ w: 60, r: 10, done: true }, { w: 60, r: 10, done: false }] },
      { id: LIFT, target: { mode: 'time' }, sets: [{ sec: 60, w: 20, done: true }] },
      { id: CARDIO, sets: [{ min: 20, speed: 9, done: true }] }
    ] }
    expect(workoutVolume(w)).toBe(600)
  })
})

describe('unifiedHistory & getUnifiedHistory (Issue #52)', () => {
  const sampleWorkouts = [
    { id: 'w1', d: '2026-11-08', start: 1762600000000, name: 'Leg Day', vol: 4500 },
    { id: 'w2', d: '2026-11-10', start: 1762780000000, name: 'Upper Body', vol: 3200 }
  ]
  const sampleCardio = [
    { id: 'c1', type: 'run', startTime: '2026-11-09T08:00:00Z', durationMs: 1800000, distanceM: 5000 },
    { id: 'c2', type: 'ride', startTime: '2026-11-11T14:30:00Z', durationMs: 3600000, distanceM: 25000 }
  ]

  it('merges workouts and cardio activities and sorts by date descending', () => {
    const S = { workouts: sampleWorkouts, cardioActivities: sampleCardio }
    const history = unifiedHistory(S)

    expect(history).toHaveLength(4)
    // Newest first: c2 (Nov 11) -> w2 (Nov 10) -> c1 (Nov 9) -> w1 (Nov 8)
    expect(history[0].id).toBe('c2')
    expect(history[0].entryType).toBe('cardio')
    expect(history[0].type).toBe('cardio')
    expect(history[0].cardioType).toBe('ride')

    expect(history[1].id).toBe('w2')
    expect(history[1].entryType).toBe('workout')
    expect(history[1].type).toBe('workout')

    expect(history[2].id).toBe('c1')
    expect(history[2].entryType).toBe('cardio')
    expect(history[2].cardioType).toBe('run')

    expect(history[3].id).toBe('w1')
    expect(history[3].entryType).toBe('workout')
  })

  it('getUnifiedHistory is an alias for unifiedHistory', () => {
    const S = { workouts: sampleWorkouts, cardioActivities: sampleCardio }
    expect(getUnifiedHistory(S)).toEqual(unifiedHistory(S))
  })

  it('handles empty state gracefully', () => {
    expect(unifiedHistory(null)).toEqual([])
    expect(unifiedHistory({})).toEqual([])
    expect(unifiedHistory({ workouts: [], cardioActivities: [] })).toEqual([])
  })

  it('filters by entry type: workout', () => {
    const S = { workouts: sampleWorkouts, cardioActivities: sampleCardio }
    const workoutsOnly = unifiedHistory(S, 'workout')
    expect(workoutsOnly).toHaveLength(2)
    expect(workoutsOnly.every(item => item.entryType === 'workout')).toBe(true)
    expect(workoutsOnly[0].id).toBe('w2')
    expect(workoutsOnly[1].id).toBe('w1')
  })

  it('filters by entry type: cardio', () => {
    const S = { workouts: sampleWorkouts, cardioActivities: sampleCardio }
    const cardioOnly = unifiedHistory(S, 'cardio')
    expect(cardioOnly).toHaveLength(2)
    expect(cardioOnly.every(item => item.entryType === 'cardio')).toBe(true)
    expect(cardioOnly[0].id).toBe('c2')
    expect(cardioOnly[1].id).toBe('c1')
  })

  it('filters by options object with filter and limit', () => {
    const S = { workouts: sampleWorkouts, cardioActivities: sampleCardio }
    const limited = unifiedHistory(S, { filter: 'all', limit: 2 })
    expect(limited).toHaveLength(2)
    expect(limited[0].id).toBe('c2')
    expect(limited[1].id).toBe('w2')
  })

  it('handles fallback date formatting for cardio without startTime', () => {
    const S = {
      workouts: [],
      cardioActivities: [{ id: 'c3', type: 'hike', d: '2026-11-05', durationMs: 1200000 }]
    }
    const history = unifiedHistory(S)
    expect(history).toHaveLength(1)
    expect(history[0].d).toBe('2026-11-05')
    expect(history[0].entryType).toBe('cardio')
  })
})

describe('groupHistoryByDate (Issue #52)', () => {
  it('groups unified history items by ISO date string', () => {
    const items = [
      { id: '1', d: '2026-11-10', entryType: 'workout' },
      { id: '2', d: '2026-11-10', entryType: 'cardio' },
      { id: '3', d: '2026-11-09', entryType: 'workout' }
    ]
    const grouped = groupHistoryByDate(items)
    expect(Object.keys(grouped)).toEqual(['2026-11-10', '2026-11-09'])
    expect(grouped['2026-11-10']).toHaveLength(2)
    expect(grouped['2026-11-09']).toHaveLength(1)
  })

  it('groups directly from state S', () => {
    const S = {
      workouts: [{ id: 'w1', d: '2026-11-10' }],
      cardioActivities: [{ id: 'c1', startTime: '2026-11-10T15:00:00Z' }]
    }
    const grouped = groupHistoryByDate(S)
    expect(grouped['2026-11-10']).toHaveLength(2)
  })

  it('handles empty input', () => {
    expect(groupHistoryByDate([])).toEqual({})
    expect(groupHistoryByDate(null)).toEqual({})
  })
})

describe('streakWeeks with cardio activities (Issue #52)', () => {
  it('includes active cardio days in weekly streak count', () => {
    const now = new Date()
    const isoOfDate = d => {
      const pad = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }

    const thisWeekDate = new Date(now)
    const lastWeekDate = new Date(now)
    lastWeekDate.setDate(lastWeekDate.getDate() - 7)

    const S = {
      workouts: [{ id: 'w1', d: isoOfDate(thisWeekDate) }],
      cardioActivities: [{ id: 'c1', startTime: lastWeekDate.toISOString() }]
    }
    expect(streakWeeks(S)).toBeGreaterThanOrEqual(2)
  })
})

describe('unifiedHistory, streakWeeks & effectiveDaySessions (Issue #92)', () => {
  it('merges workouts, cardioActivities, and freestyleSessions with canonical entryType and pillar', () => {
    const S = {
      routines: [
        { id: 'r-gym', name: 'Push', kind: 'gym' },
        { id: 'r-yoga', name: 'Flow', kind: 'yoga' }
      ],
      workouts: [
        { id: 'w-gym', d: '2026-11-10', start: 1762770000000, routineId: 'r-gym' },
        { id: 'w-yoga', d: '2026-11-11', start: 1762850000000, routineId: 'r-yoga' },
        { id: 'w-hiit', d: '2026-11-12', start: 1762930000000, kind: 'hiit' }
      ],
      cardioActivities: [
        { id: 'c-run', type: 'run', startTime: '2026-11-13T08:00:00Z', durationMs: 1800000 }
      ],
      freestyleSessions: [
        { id: 'f-mob', kind: 'mobility', startTime: '2026-11-14T09:00:00Z', durationMs: 900000 },
        { id: 'f-other', kind: 'stretching', startTime: '2026-11-15T09:00:00Z', durationMs: 600000 }
      ]
    }

    const all = unifiedHistory(S)
    expect(all.map(x => x.id)).toEqual(['f-other', 'f-mob', 'c-run', 'w-hiit', 'w-yoga', 'w-gym'])

    const byId = Object.fromEntries(all.map(x => [x.id, x]))
    expect(byId['w-gym'].entryType).toBe('workout')
    expect(byId['w-gym'].pillar).toBe('strength')
    expect(byId['w-yoga'].entryType).toBe('workout')
    expect(byId['w-yoga'].pillar).toBe('flow')
    expect(byId['w-hiit'].pillar).toBe('flow')
    expect(byId['c-run'].entryType).toBe('cardio')
    expect(byId['c-run'].pillar).toBe('cardio')
    expect(byId['f-mob'].entryType).toBe('freestyle')
    expect(byId['f-mob'].pillar).toBe('flow')
    expect(byId['f-other'].entryType).toBe('freestyle')
    expect(byId['f-other'].pillar).toBe('freestyle')

    // Filters: strength / workout alias, cardio, flow (includes flow + freestyle), limit
    expect(unifiedHistory(S, 'strength').map(x => x.id)).toEqual(['w-gym'])
    expect(unifiedHistory(S, 'workout').map(x => x.id)).toEqual(['w-gym'])
    expect(unifiedHistory(S, 'cardio').map(x => x.id)).toEqual(['c-run'])
    expect(unifiedHistory(S, 'flow').map(x => x.id)).toEqual(['f-other', 'f-mob', 'w-hiit', 'w-yoga'])
    expect(unifiedHistory(S, { filter: 'flow', limit: 2 }).map(x => x.id)).toEqual(['f-other', 'f-mob'])
  })

  it('streakWeeks counts freestyleSessions, multiple date formats, and ignores invalid dates', () => {
    const isoOfDate = d => {
      const pad = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    const now = new Date()
    const w1 = new Date(now)
    const w2 = new Date(now); w2.setDate(w2.getDate() - 7)
    const w3 = new Date(now); w3.setDate(w3.getDate() - 14)
    const w4 = new Date(now); w4.setDate(w4.getDate() - 21)

    const S = {
      workouts: [
        { id: 'w-cur', date: isoOfDate(w1) },
        { id: 'w-bad1', d: 'not-a-date' },
        { id: 'w-bad2', d: '2026-02-30' },
        { id: 'w-empty' }
      ],
      cardioActivities: [
        { id: 'c-prev', startTime: w2.getTime() },
        { id: 'c-zero', startTime: 0 }
      ],
      freestyleSessions: [
        { id: 'f-w3', completedAt: w3.toISOString() },
        { id: 'f-w4', start: w4.getTime() },
        { id: 'f-bad', startTime: 'invalid' }
      ]
    }
    expect(streakWeeks(S)).toBeGreaterThanOrEqual(4)
    expect(streakWeeks({ workouts: [{ d: 'bad' }], cardioActivities: [{ startTime: null }], freestyleSessions: [{}] })).toBe(0)
  })

  it('effectiveRoutineId handles scalar, array, empty, rest, and __rest__ tokens', () => {
    const S = {
      routines: [{ id: 'r1', name: 'Push' }, { id: 'r2', name: 'Pull' }],
      cardioPlans: [{ id: 'cp1', type: 'run', day: 1 }],
      week: {
        1: ['cp1', 'r1'], // Monday 2026-11-16
        2: 'r2',          // Tuesday 2026-11-17
        3: ['rest'],      // Wednesday 2026-11-18
        4: '__rest__',    // Thursday 2026-11-19
        5: []             // Friday 2026-11-20
      },
      dayPlan: {
        '2026-11-17': 'rest',
        '2026-11-18': ['r2', 'r1'],
        '2026-11-20': ['__rest__'],
        '2026-11-21': ['cp1']
      }
    }

    expect(effectiveRoutineId(S, '2026-11-16')).toBe('r1')
    expect(effectiveRoutineId(S, '2026-11-17')).toBeNull()
    expect(effectiveRoutineId(S, '2026-11-18')).toBe('r2')
    expect(effectiveRoutineId(S, '2026-11-19')).toBeNull()
    expect(effectiveRoutineId(S, '2026-11-20')).toBeNull()
    expect(effectiveRoutineId(S, '2026-11-21')).toBeNull()
  })

  it('effectiveDaySessions resolves weekly, overrides, rest overrides, deduplication, and completed sessions', () => {
    const r1 = { id: 'r1', name: 'Upper', kind: 'gym' }
    const r2 = { id: 'r2', name: 'Yoga', kind: 'yoga' }
    const cpMon = { id: 'cp-mon', type: 'run', day: 1 }
    const cpDate = { id: 'cp-date', type: 'ride', date: '2026-11-16' }

    const base = {
      routines: [r1, r2],
      cardioPlans: [cpMon, cpDate],
      week: {
        1: ['r1', 'r1', 'cp-mon'], // Monday 2026-11-16
        2: ['__rest__']            // Tuesday 2026-11-17
      },
      dayPlan: {},
      workouts: [{ id: 'w1', d: '2026-11-16', start: '2026-11-16T06:00:00Z', routineId: 'r1' }],
      cardioActivities: [{ id: 'c1', type: 'run', startTime: '2026-11-16T08:00:00Z' }],
      freestyleSessions: [{ id: 'f1', kind: 'yoga', startTime: '2026-11-16T18:00:00Z' }]
    }

    // Standard Monday: deduplicated r1, cp-mon, and date-specific cp-date, plus all 3 completed sessions
    const mon = effectiveDaySessions(base, '2026-11-16')
    expect(mon.isRest).toBe(false)
    expect(mon.isOverride).toBe(false)
    expect(mon.routines.map(r => r.id)).toEqual(['r1'])
    expect(mon.cardioPlans.map(p => p.id)).toEqual(['cp-mon', 'cp-date'])
    expect(mon.completed.map(c => c.id)).toEqual(['f1', 'c1', 'w1'])

    // Non-rest dayPlan override: overrides week[1] routines and weekday cp-mon, preserves date-specific cp-date
    const nonRestOv = { ...base, dayPlan: { '2026-11-16': ['r2'] } }
    const resOv = effectiveDaySessions(nonRestOv, '2026-11-16')
    expect(resOv.isOverride).toBe(true)
    expect(resOv.isRest).toBe(false)
    expect(resOv.routines.map(r => r.id)).toEqual(['r2'])
    expect(resOv.cardioPlans.map(p => p.id)).toEqual(['cp-date'])
    expect(resOv.completed).toHaveLength(3)

    // Rest override: suppresses weekly routines & cardioPlans while preserving completed sessions
    for (const restVal of ['rest', '__rest__', ['rest'], ['__rest__']]) {
      const restOv = { ...base, dayPlan: { '2026-11-16': restVal } }
      const resRest = effectiveDaySessions(restOv, '2026-11-16')
      expect(resRest.isOverride).toBe(true)
      expect(resRest.isRest).toBe(true)
      expect(resRest.routines).toEqual([])
      expect(resRest.cardioPlans).toEqual([])
      expect(resRest.completed).toHaveLength(3)
    }

    // Empty dayPlan [] is not an override
    const emptyOv = { ...base, dayPlan: { '2026-11-16': [] } }
    const resEmptyOv = effectiveDaySessions(emptyOv, '2026-11-16')
    expect(resEmptyOv.isOverride).toBe(false)
    expect(resEmptyOv.routines.map(r => r.id)).toEqual(['r1'])

    // Weekly __rest__
    const tue = effectiveDaySessions(base, '2026-11-17')
    expect(tue.isOverride).toBe(false)
    expect(tue.isRest).toBe(true)
    expect(tue.routines).toEqual([])
    expect(tue.cardioPlans).toEqual([])
  })
})

