import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  CARDIO_PLAN_TYPES,
  createCardioPlan,
  validateCardioPlan,
  getCardioPlans,
  getCardioPlansForDay,
  getActivityDate,
  getDayOfWeekFromDate,
  getActivityDayOfWeek,
  matchesCardioPlan,
  findMatchingCardioPlan,
  linkCardioPlan,
  unlinkCardioPlan,
  autoLinkCardioActivities,
  addCardioPlan,
  removeCardioPlan,
  updateCardioPlan,
  formatCardioTarget,
  addCardioPlanToStore,
  removeCardioPlanFromStore,
  updateCardioPlanInStore
} from './cardio-plan.js'
import { useStore, DEF } from '../store/useStore.js'
import Plan, { CardioPlanSheet } from '../views/Plan.jsx'

if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store }
  }
}

describe('Manual Cardio Planning & Automatic Activity Linking (Issue #58)', () => {
  beforeEach(() => {
    localStorage.clear()
    useStore.setState({
      S: JSON.parse(JSON.stringify(DEF)),
      user: null
    })
  })

  describe('createCardioPlan and normalisation', () => {
    it('creates a cardio plan with default values', () => {
      const plan = createCardioPlan()
      expect(plan.id).toMatch(/^cardio-plan-/)
      expect(plan.type).toBe('run')
      expect(plan.targetDistanceM).toBeNull()
      expect(plan.targetDurationMs).toBeNull()
      expect(plan.notes).toBe('')
      expect(plan.day).toBeNull()
      expect(plan.date).toBeNull()
      expect(plan.completed).toBe(false)
      expect(plan.activityId).toBeNull()
    })

    it('normalizes target distance, duration, day, and notes', () => {
      const plan = createCardioPlan({
        id: 'plan-custom-1',
        type: 'ride',
        targetDistanceM: 20000,
        targetDurationMs: 3600000,
        notes: '   Zone 2 endurance ride   ',
        day: 2,
        date: '2026-11-17'
      })

      expect(plan.id).toBe('plan-custom-1')
      expect(plan.type).toBe('ride')
      expect(plan.targetDistanceM).toBe(20000)
      expect(plan.targetDurationMs).toBe(3600000)
      expect(plan.notes).toBe('Zone 2 endurance ride')
      expect(plan.day).toBe(2)
      expect(plan.date).toBe('2026-11-17')
      expect(plan.completed).toBe(false)
    })

    it('clamps or handles invalid days and negative distances gracefully', () => {
      const plan = createCardioPlan({
        type: 'invalid-type',
        targetDistanceM: -500,
        targetDurationMs: -1000,
        day: 8
      })
      expect(plan.type).toBe('run')
      expect(plan.targetDistanceM).toBeNull()
      expect(plan.targetDurationMs).toBeNull()
      expect(plan.day).toBe(6) // clamped to 6
    })
  })

  describe('validateCardioPlan', () => {
    it('passes on valid cardio plan', () => {
      const res = validateCardioPlan({
        type: 'run',
        targetDistanceM: 5000,
        targetDurationMs: 1800000,
        day: 1,
        date: '2026-11-16'
      })
      expect(res.valid).toBe(true)
      expect(res.errors).toEqual([])
    })

    it('rejects invalid types and negative targets', () => {
      const res = validateCardioPlan({
        type: 'swimming',
        targetDistanceM: -10,
        targetDurationMs: NaN,
        day: 7,
        date: 'invalid-date'
      })
      expect(res.valid).toBe(false)
      expect(res.errors.length).toBeGreaterThan(0)
    })
  })

  describe('Date & weekday resolution', () => {
    it('extracts date from activity d, date, or startTime', () => {
      expect(getActivityDate({ d: '2026-11-16' })).toBe('2026-11-16')
      expect(getActivityDate({ date: '2026-11-16' })).toBe('2026-11-16')
      expect(getActivityDate({ startTime: '2026-11-16T10:00:00Z' })).toBe('2026-11-16')
      expect(getActivityDate(null)).toBeNull()
    })

    it('calculates correct day of week for ISO date (2026-11-16 is Monday = 1)', () => {
      expect(getDayOfWeekFromDate('2026-11-16')).toBe(1) // Monday
      expect(getDayOfWeekFromDate('2026-11-15')).toBe(0) // Sunday
      expect(getDayOfWeekFromDate('2026-11-21')).toBe(6) // Saturday
    })

    it('calculates activity day of week correctly', () => {
      const act = { id: 'act-1', type: 'run', startTime: '2026-11-16T08:00:00Z' }
      expect(getActivityDayOfWeek(act)).toBe(1)
    })
  })

  describe('matchesCardioPlan matching logic', () => {
    it('matches activity on same weekday and matching type', () => {
      const plan = { type: 'run', day: 1 } // Monday run
      const actMon = { id: 'a1', type: 'run', startTime: '2026-11-16T07:30:00Z' } // Monday
      const actTue = { id: 'a2', type: 'run', startTime: '2026-11-17T07:30:00Z' } // Tuesday
      const actMonRide = { id: 'a3', type: 'ride', startTime: '2026-11-16T07:30:00Z' } // Monday ride

      expect(matchesCardioPlan(plan, actMon)).toBe(true)
      expect(matchesCardioPlan(plan, actTue)).toBe(false) // Different day
      expect(matchesCardioPlan(plan, actMonRide)).toBe(false) // Different type
    })

    it('matches activity on specific plan date', () => {
      const plan = { type: 'ride', date: '2026-11-20' }
      const actMatch = { id: 'a1', type: 'ride', d: '2026-11-20' }
      const actDiff = { id: 'a2', type: 'ride', d: '2026-11-21' }

      expect(matchesCardioPlan(plan, actMatch)).toBe(true)
      expect(matchesCardioPlan(plan, actDiff)).toBe(false)
    })
  })

  describe('findMatchingCardioPlan', () => {
    it('finds uncompleted matching plan and prefers closest distance target', () => {
      const plan5k = { id: 'p5', type: 'run', day: 1, targetDistanceM: 5000, completed: false }
      const plan10k = { id: 'p10', type: 'run', day: 1, targetDistanceM: 10000, completed: false }

      const act9k = { id: 'a1', type: 'run', distanceM: 9500, startTime: '2026-11-16T08:00:00Z' }
      const matched = findMatchingCardioPlan([plan5k, plan10k], act9k)

      expect(matched?.id).toBe('p10')
    })

    it('skips already completed plans', () => {
      const planDone = { id: 'p1', type: 'run', day: 1, completed: true, activityId: 'old-act' }
      const planPending = { id: 'p2', type: 'run', day: 1, completed: false }

      const act = { id: 'a2', type: 'run', startTime: '2026-11-16T08:00:00Z' }
      const matched = findMatchingCardioPlan([planDone, planPending], act)

      expect(matched?.id).toBe('p2')
    })
  })

  describe('linkCardioPlan and unlinkCardioPlan', () => {
    it('links activity to plan and marks completed', () => {
      const plan = createCardioPlan({ id: 'p1', type: 'run', day: 1 })
      const act = { id: 'act-101', type: 'run', startTime: '2026-11-16T09:00:00Z' }

      const linked = linkCardioPlan(plan, act)
      expect(linked.completed).toBe(true)
      expect(linked.activityId).toBe('act-101')
      expect(linked.completedAt).toBe('2026-11-16T09:00:00Z')

      const unlinked = unlinkCardioPlan(linked)
      expect(unlinked.completed).toBe(false)
      expect(unlinked.activityId).toBeNull()
      expect(unlinked.completedAt).toBeNull()
    })
  })

  describe('autoLinkCardioActivities automatic same-day linking', () => {
    it('automatically links logged activity on same day to planned session and marks completed', () => {
      const state = {
        cardioPlans: [
          createCardioPlan({ id: 'cp-mon-run', type: 'run', day: 1, targetDistanceM: 5000 }),
          createCardioPlan({ id: 'cp-wed-ride', type: 'ride', day: 3, targetDistanceM: 20000 })
        ],
        cardioActivities: [
          // Monday activity
          { id: 'act-mon-run', type: 'run', distanceM: 5100, startTime: '2026-11-16T07:00:00Z' }
        ]
      }

      autoLinkCardioActivities(state)

      const monPlan = state.cardioPlans.find(p => p.id === 'cp-mon-run')
      const wedPlan = state.cardioPlans.find(p => p.id === 'cp-wed-ride')

      expect(monPlan.completed).toBe(true)
      expect(monPlan.activityId).toBe('act-mon-run')
      expect(wedPlan.completed).toBe(false)
      expect(wedPlan.activityId).toBeNull()
    })

    it('unlinks plan if activity is removed from cardioActivities', () => {
      const state = {
        cardioPlans: [
          createCardioPlan({
            id: 'cp-1',
            type: 'run',
            day: 1,
            completed: true,
            activityId: 'act-deleted'
          })
        ],
        cardioActivities: []
      }

      autoLinkCardioActivities(state)
      expect(state.cardioPlans[0].completed).toBe(false)
      expect(state.cardioPlans[0].activityId).toBeNull()
    })

    it('handles multiple same-day sessions without assigning the same activity twice', () => {
      const state = {
        cardioPlans: [
          createCardioPlan({ id: 'cp-run-1', type: 'run', day: 1, targetDistanceM: 5000 }),
          createCardioPlan({ id: 'cp-run-2', type: 'run', day: 1, targetDistanceM: 3000 })
        ],
        cardioActivities: [
          { id: 'act-run-1', type: 'run', distanceM: 5200, startTime: '2026-11-16T08:00:00Z' },
          { id: 'act-run-2', type: 'run', distanceM: 3100, startTime: '2026-11-16T18:00:00Z' }
        ]
      }

      autoLinkCardioActivities(state)

      const plan1 = state.cardioPlans.find(p => p.id === 'cp-run-1')
      const plan2 = state.cardioPlans.find(p => p.id === 'cp-run-2')

      expect(plan1.completed).toBe(true)
      expect(plan2.completed).toBe(true)
      expect(plan1.activityId).not.toBe(plan2.activityId)
    })
  })

  describe('addCardioPlan, removeCardioPlan, updateCardioPlan & weekly schedule', () => {
    it('adds cardio plan and links to weekly schedule week[day]', () => {
      const state = {
        week: { 1: ['routine-push'] },
        cardioPlans: [],
        cardioActivities: []
      }

      const plan = addCardioPlan(state, {
        id: 'cardio-mon',
        type: 'run',
        day: 1,
        targetDistanceM: 5000
      })

      expect(state.cardioPlans.length).toBe(1)
      expect(state.cardioPlans[0].id).toBe('cardio-mon')
      expect(state.week[1]).toEqual(['routine-push', 'cardio-mon'])

      const dayPlans = getCardioPlansForDay(state, 1)
      expect(dayPlans.length).toBe(1)
      expect(dayPlans[0].id).toBe('cardio-mon')
    })

    it('removes cardio plan and cleans up weekly schedule week[day]', () => {
      const state = {
        week: { 1: ['routine-push', 'cardio-mon'] },
        cardioPlans: [{ id: 'cardio-mon', type: 'run', day: 1 }]
      }

      const removed = removeCardioPlan(state, 'cardio-mon')
      expect(removed).toBe(true)
      expect(state.cardioPlans.length).toBe(0)
      expect(state.week[1]).toEqual(['routine-push'])
    })

    it('updates cardio plan and adjusts weekly schedule on day change', () => {
      const state = {
        week: { 1: ['cardio-mon'] },
        cardioPlans: [{ id: 'cardio-mon', type: 'run', day: 1, targetDistanceM: 5000 }],
        cardioActivities: []
      }

      updateCardioPlan(state, 'cardio-mon', {
        day: 2,
        targetDistanceM: 8000,
        notes: 'Updated long run'
      })

      expect(state.cardioPlans[0].day).toBe(2)
      expect(state.cardioPlans[0].targetDistanceM).toBe(8000)
      expect(state.cardioPlans[0].notes).toBe('Updated long run')
      expect(state.week[1]).toBeUndefined()
      expect(state.week[2]).toEqual(['cardio-mon'])
    })
  })

  describe('formatCardioTarget', () => {
    it('formats target with distance and duration in metric', () => {
      const plan = { type: 'run', targetDistanceM: 5000, targetDurationMs: 1800000 }
      const str = formatCardioTarget(plan, 'kg')
      expect(str).toContain('Run')
      expect(str).toContain('5 km')
      expect(str).toContain('30 min')
    })

    it('formats target with imperial distance', () => {
      const plan = { type: 'ride', targetDistanceM: 16093.44 } // ~10 miles
      const str = formatCardioTarget(plan, 'lbs')
      expect(str).toContain('Ride')
      expect(str).toContain('10 mi')
    })

    it('formats target with notes or without distance/duration', () => {
      const plan = { type: 'walk' }
      expect(formatCardioTarget(plan)).toBe('Walk')
    })
  })

  describe('Store integration helpers', () => {
    it('addCardioPlanToStore, updateCardioPlanInStore and removeCardioPlanFromStore work with useStore', () => {
      const store = useStore.getState()
      const plan = addCardioPlanToStore({
        type: 'run',
        day: 3,
        targetDistanceM: 6000
      })

      expect(useStore.getState().S.cardioPlans.length).toBe(1)
      expect(useStore.getState().S.week[3]).toContain(plan.id)

      updateCardioPlanInStore(plan.id, { notes: 'Midweek tempo' })
      expect(useStore.getState().S.cardioPlans[0].notes).toBe('Midweek tempo')

      removeCardioPlanFromStore(plan.id)
      expect(useStore.getState().S.cardioPlans.length).toBe(0)
      expect(useStore.getState().S.week[3]).toBeUndefined()
    })

    it('automatically links when cardio activity is logged in store', () => {
      addCardioPlanToStore({
        id: 'plan-friday-ride',
        type: 'ride',
        day: 5,
        targetDistanceM: 25000
      })

      // 2026-11-20 is a Friday (day 5)
      useStore.getState().logCardioActivity({
        id: 'act-fri-ride',
        type: 'ride',
        distanceM: 25500,
        startTime: '2026-11-20T16:00:00Z'
      })

      // Re-sync store plans
      useStore.getState().update(s => {
        autoLinkCardioActivities(s)
      })

      const plan = useStore.getState().S.cardioPlans.find(p => p.id === 'plan-friday-ride')
      expect(plan.completed).toBe(true)
      expect(plan.activityId).toBe('act-fri-ride')
    })
  })

  describe('UI Component Integration (CardioPlanSheet & Plan View)', () => {
    it('renders CardioPlanSheet in create mode with targets inputs', () => {
      const html = renderToStaticMarkup(
        React.createElement(CardioPlanSheet, { close: () => {} })
      )
      expect(html).toContain('Schedule cardio target')
      expect(html).toContain('Run')
      expect(html).toContain('Ride')
      expect(html).toContain('Distance')
      expect(html).toContain('Duration (min)')
      expect(html).toContain('Notes')
      expect(html).not.toContain('trash')
    })

    it('renders CardioPlanSheet in edit mode with delete button', () => {
      const existing = {
        id: 'cp-edit',
        type: 'ride',
        day: 2,
        targetDistanceM: 15000,
        targetDurationMs: 2700000,
        notes: 'Hill climbs'
      }
      const html = renderToStaticMarkup(
        React.createElement(CardioPlanSheet, { existing, close: () => {} })
      )
      expect(html).toContain('Edit cardio target')
      expect(html).toContain('Delete')
      expect(html).toContain('Hill climbs')
    })

    it('renders Plan view with Week schedule and Cardio targets section', () => {
      addCardioPlanToStore({
        id: 'plan-1',
        type: 'run',
        day: 1, // Monday
        targetDistanceM: 5000,
        targetDurationMs: 1800000,
        notes: 'Easy run',
        completed: true
      })

      const html = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(Plan)
        )
      )

      expect(html).toContain('Plan')
      expect(html).toContain('Week schedule')
      expect(html).toContain('Cardio targets')
      expect(html).toContain('Run · 5 km · 30 min')
      expect(html).toContain('Completed')
    })

    it('renders Structured Intervals Switch in CardioPlanSheet and IntervalEditor when intervals exist', () => {
      const createHtml = renderToStaticMarkup(
        React.createElement(CardioPlanSheet, { close: () => {} })
      )
      expect(createHtml).toContain('Structured Intervals')
      expect(createHtml).not.toContain('data-testid="interval-editor"')

      const existing = createCardioPlan({
        id: 'cp-intervals',
        type: 'run',
        day: 3,
        intervals: [
          { type: 'warmup', durationMs: 300000 },
          { type: 'repeat', count: 4, workStep: { type: 'work', durationMs: 120000 }, recoverStep: { type: 'recover', durationMs: 60000 } }
        ]
      })
      const editHtml = renderToStaticMarkup(
        React.createElement(CardioPlanSheet, { existing, close: () => {} })
      )
      expect(editHtml).toContain('Structured Intervals')
      expect(editHtml).toContain('data-testid="interval-editor"')
    })

    it('renders multiple routine + cardio tags and handles rest tokens in Plan weekday rows', () => {
      useStore.setState({
        S: {
          ...JSON.parse(JSON.stringify(DEF)),
          routines: [
            { id: 'r-push', name: 'Push', emoji: 'dumbbell', kind: 'gym', ex: [] },
            { id: 'r-yoga', name: 'Evening Yoga', emoji: 'sparkles', kind: 'yoga', ex: [] }
          ],
          cardioPlans: [
            createCardioPlan({
              id: 'cp-mon-iv',
              type: 'run',
              day: 1,
              intervals: [{ type: 'work', durationMs: 600000 }]
            }),
            createCardioPlan({
              id: 'cp-tue-ignored',
              type: 'ride',
              day: 2,
              targetDistanceM: 10000
            })
          ],
          week: {
            1: ['r-push', 'r-yoga', 'cp-mon-iv'],
            2: ['__rest__'],
            3: 'r-push'
          }
        }
      })

      const html = renderToStaticMarkup(
        React.createElement(MemoryRouter, null, React.createElement(Plan))
      )
      const weekSection = html.split('Cardio targets')[0]
      expect(weekSection).toContain('Push')
      expect(weekSection).toContain('Evening Yoga')
      expect(weekSection).toContain('1 interval')
      expect(weekSection).toContain('10m')
      expect(weekSection).not.toContain('10 km')
    })
  })

  describe('Structured Cardio Intervals persistence & formatting (Issue #94)', () => {
    it('createCardioPlan cleans and persists intervals and defaults to []', () => {
      const empty = createCardioPlan({ type: 'run' })
      expect(empty.intervals).toEqual([])

      const withSteps = createCardioPlan({
        type: 'run',
        intervals: [
          { type: 'warmup', durationMs: '300000', notes: '  easy  ' },
          { type: 'repeat', count: 3.7, workStep: { type: 'work', distanceM: 400 }, recoverStep: { type: 'recover', durationMs: 60000 } }
        ]
      })
      expect(withSteps.intervals).toHaveLength(2)
      expect(withSteps.intervals[0].durationMs).toBe(300000)
      expect(withSteps.intervals[0].notes).toBe('easy')
      expect(withSteps.intervals[1].count).toBe(3)
      expect(withSteps.intervals[1].workStep.distanceM).toBe(400)
    })

    it('validateCardioPlan validates intervals via validateIntervalSteps', () => {
      const validPlan = createCardioPlan({
        type: 'ride',
        intervals: [{ type: 'work', durationMs: 180000 }]
      })
      expect(validateCardioPlan(validPlan)).toEqual({ valid: true, errors: [] })

      const badSteps = validateCardioPlan({
        type: 'run',
        intervals: [{ type: 'work', durationMs: -5 }]
      })
      expect(badSteps.valid).toBe(false)
      expect(badSteps.errors.length).toBeGreaterThan(0)

      const nonArray = validateCardioPlan({ type: 'run', intervals: 'invalid' })
      expect(nonArray.valid).toBe(false)
    })

    it('updateCardioPlan updates intervals and cleans scalar week[oldDay] on day move', () => {
      const state = {
        week: { 1: 'cp-scalar' },
        cardioPlans: [createCardioPlan({ id: 'cp-scalar', type: 'run', day: 1 })],
        cardioActivities: []
      }
      updateCardioPlan(state, 'cp-scalar', {
        day: 4,
        intervals: [{ type: 'work', durationMs: 240000 }]
      })
      expect(state.week[1]).toBeUndefined()
      expect(state.week[4]).toEqual(['cp-scalar'])
      expect(state.cardioPlans[0].intervals).toHaveLength(1)
      expect(state.cardioPlans[0].intervals[0].durationMs).toBe(240000)
    })

    it('formatCardioTarget formats interval summary without steady-state distance/duration', () => {
      const durPlan = {
        type: 'run',
        intervals: [
          { type: 'warmup', durationMs: 300000 },
          { type: 'repeat', count: 4, workStep: { type: 'work', durationMs: 120000 }, recoverStep: { type: 'recover', durationMs: 60000 } }
        ]
      }
      expect(formatCardioTarget(durPlan, 'kg')).toBe('Run · 9 intervals · 17m')

      const distPlan = {
        type: 'ride',
        intervals: [{ type: 'work', distanceM: 2000 }]
      }
      expect(formatCardioTarget(distPlan, 'kg')).toBe('Ride · 1 interval · 2 km')

      const combinedPlan = {
        type: 'run',
        targetDistanceM: 5000,
        targetDurationMs: 1800000,
        intervals: [{ type: 'work', durationMs: 600000 }]
      }
      expect(formatCardioTarget(combinedPlan, 'kg')).toBe('Run · 5 km · 30 min · 1 interval')
    })
  })
})
