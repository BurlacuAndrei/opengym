// Starter routine & multi-sport plan templates.
// starterRoutines() is shared by "Load starter plan" in Settings and demoSeed.js.
import { uid } from './format.js'
import { createCardioPlan } from './cardio-plan.js'

const SPEC = [
  ['Push Day', 'barbell', [['0025', 4, 8], ['0047', 3, 10], ['0426', 3, 10], ['0334', 3, 12], ['0241', 3, 12], ['0251', 3, 10]]],
  ['Pull Day', 'pullup', [['2330', 4, 10], ['0027', 4, 8], ['1323', 3, 10], ['0031', 3, 10], ['0313', 3, 12]]],
  ['Leg Day', 'legs', [['0043', 4, 8], ['0085', 3, 10], ['0739', 3, 12], ['0585', 3, 12], ['0586', 3, 12], ['0605', 4, 15]]]
]

// Fresh routine objects (new ids) — [push, pull, legs].
export const starterRoutines = () =>
  SPEC.map(([name, emoji, list]) => ({ id: uid(), name, emoji, kind: 'gym', ex: list.map(([id, sets, reps]) => ({ id, sets, reps, weight: 0 })) }))

const repsEx = list => list.map(([id, sets, reps]) => ({ id, sets, reps, weight: 0 }))
const timeEx = list => list.map(([id, sets, sec]) => ({ id, sets, sec, weight: 0, mode: 'time' }))

export const STARTER_PLANS = [
  {
    id: 'hybrid',
    name: 'Hybrid Athlete',
    description: 'Strength, HIIT conditioning, running, and recovery mobility.',
    emoji: 'bolt',
    build() {
      const upper = {
        id: uid(), name: 'Upper Strength', emoji: 'barbell', kind: 'gym',
        ex: repsEx([['0025', 4, 8], ['0027', 4, 8], ['0426', 3, 10], ['2330', 3, 10], ['0241', 3, 12]])
      }
      const lower = {
        id: uid(), name: 'Lower Strength', emoji: 'legs', kind: 'gym',
        ex: repsEx([['0043', 4, 8], ['0085', 3, 10], ['0054', 3, 10], ['0586', 3, 12], ['0605', 4, 15]])
      }
      const hiit = {
        id: uid(), name: 'Conditioning HIIT', emoji: 'flame', kind: 'hiit',
        ex: timeEx([['1160', 3, 40], ['0630', 3, 40], ['3224', 3, 40], ['3360', 3, 40], ['0464', 3, 45]])
      }
      const mobility = {
        id: uid(), name: 'Recovery Mobility', emoji: 'stretch', kind: 'mobility',
        ex: timeEx([['1604', 2, 45], ['fedb-cat_stretch', 2, 45], ['fedb-childs_pose', 2, 60], ['fedb-90_90_hamstring', 2, 45]])
      }
      const tempoRun = createCardioPlan({ type: 'run', day: 2, targetDistanceM: 5000, targetDurationMs: 1800000, notes: 'Tempo run' })
      const longRun = createCardioPlan({ type: 'run', day: 6, targetDistanceM: 10000, targetDurationMs: 3600000, notes: 'Long aerobic run' })
      return {
        routines: [upper, lower, hiit, mobility],
        cardioPlans: [tempoRun, longRun],
        week: {
          1: [upper.id],
          2: [tempoRun.id, mobility.id],
          3: [lower.id],
          4: [hiit.id],
          5: [upper.id, mobility.id],
          6: [longRun.id]
        }
      }
    }
  },
  {
    id: 'endurance',
    name: 'Endurance Base',
    description: 'Running and cycling mileage backed by runner strength and core.',
    emoji: 'figureRun',
    build() {
      const strength = {
        id: uid(), name: 'Runner Strength', emoji: 'legs', kind: 'gym',
        ex: repsEx([['0043', 3, 8], ['0085', 3, 10], ['0054', 3, 10], ['1409', 3, 12], ['0605', 3, 15]])
      }
      const core = {
        id: uid(), name: 'Core & Mobility', emoji: 'stretch', kind: 'mobility',
        ex: timeEx([['0464', 3, 45], ['3561', 3, 45], ['1604', 2, 45], ['fedb-90_90_hamstring', 2, 45]])
      }
      const easyRun = createCardioPlan({ type: 'run', day: 1, targetDistanceM: 6000, targetDurationMs: 2100000, notes: 'Easy aerobic run' })
      const intervalsRun = createCardioPlan({ type: 'run', day: 3, targetDistanceM: 5000, targetDurationMs: 1500000, notes: 'Interval run' })
      const zone2Ride = createCardioPlan({ type: 'ride', day: 5, targetDistanceM: 25000, targetDurationMs: 3600000, notes: 'Zone 2 ride' })
      const longRun = createCardioPlan({ type: 'run', day: 6, targetDistanceM: 14000, targetDurationMs: 4800000, notes: 'Weekend long run' })
      return {
        routines: [strength, core],
        cardioPlans: [easyRun, intervalsRun, zone2Ride, longRun],
        week: {
          1: [easyRun.id, core.id],
          2: [strength.id],
          3: [intervalsRun.id],
          4: [strength.id, core.id],
          5: [zone2Ride.id],
          6: [longRun.id]
        }
      }
    }
  },
  {
    id: 'ppl',
    name: 'Push / Pull / Legs',
    description: 'Classic 3-day strength split with an active recovery walk.',
    emoji: 'dumbbell',
    build() {
      const [push, pull, legs] = starterRoutines()
      const recoveryWalk = createCardioPlan({ type: 'walk', day: 6, targetDistanceM: 4000, targetDurationMs: 2400000, notes: 'Active recovery walk' })
      return {
        routines: [push, pull, legs],
        cardioPlans: [recoveryWalk],
        week: {
          1: [push.id],
          3: [pull.id],
          5: [legs.id],
          6: [recoveryWalk.id]
        }
      }
    }
  },
  {
    id: 'mobility',
    name: 'Mobility & Flow',
    description: 'Daily yoga, joint mobility, and low-impact outdoor movement.',
    emoji: 'stretch',
    build() {
      const morningFlow = {
        id: uid(), name: 'Morning Yoga Flow', emoji: 'stretch', kind: 'yoga',
        ex: timeEx([['fedb-cat_stretch', 2, 45], ['fedb-childs_pose', 2, 60], ['1604', 2, 45], ['1363', 2, 45]])
      }
      const hipSpine = {
        id: uid(), name: 'Hip & Spine Mobility', emoji: 'heart', kind: 'mobility',
        ex: timeEx([['fedb-90_90_hamstring', 2, 45], ['1512', 2, 45], ['2567', 2, 45], ['1365', 2, 45]])
      }
      const unwind = {
        id: uid(), name: 'Evening Unwind', emoji: 'moon', kind: 'yoga',
        ex: timeEx([['fedb-hug_knees_to_chest', 2, 45], ['1511', 2, 45], ['fedb-childs_pose', 2, 60]])
      }
      const walk = createCardioPlan({ type: 'walk', day: 3, targetDistanceM: 3000, targetDurationMs: 1800000, notes: 'Brisk recovery walk' })
      const hike = createCardioPlan({ type: 'hike', day: 6, targetDistanceM: 6000, targetDurationMs: 3600000, notes: 'Weekend trail hike' })
      return {
        routines: [morningFlow, hipSpine, unwind],
        cardioPlans: [walk, hike],
        week: {
          1: [morningFlow.id, unwind.id],
          2: [hipSpine.id],
          3: [walk.id, morningFlow.id],
          4: [hipSpine.id],
          5: [morningFlow.id, unwind.id],
          6: [hike.id, unwind.id]
        }
      }
    }
  }
]

/**
 * Instantiates a fresh starter plan bundle with unique IDs.
 *
 * @param {string} id - One of 'hybrid' | 'endurance' | 'ppl' | 'mobility'
 * @returns {Object|null}
 */
export function createStarterPlan(id) {
  const tpl = STARTER_PLANS.find(p => p.id === id)
  if (!tpl) return null
  const built = tpl.build()
  return {
    id: tpl.id,
    name: tpl.name,
    description: tpl.description,
    emoji: tpl.emoji,
    routines: built.routines,
    cardioPlans: built.cardioPlans,
    week: built.week
  }
}

/**
 * Applies a starter plan template into state S in-place and returns S.
 *
 * @param {Object} S - Application state
 * @param {string} id - Starter plan id
 * @returns {Object} Updated state S
 */
export function applyStarterPlan(S, id) {
  if (!S || typeof S !== 'object') return S
  const plan = createStarterPlan(id)
  if (!plan) return S
  if (!Array.isArray(S.routines)) S.routines = []
  if (!Array.isArray(S.cardioPlans)) S.cardioPlans = []
  if (!S.week || typeof S.week !== 'object') S.week = {}

  S.routines.push(...plan.routines)
  S.cardioPlans.push(...plan.cardioPlans)
  for (const [day, ids] of Object.entries(plan.week)) {
    S.week[day] = [...ids]
  }
  return S
}
