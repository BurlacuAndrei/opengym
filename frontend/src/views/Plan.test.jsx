import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useStore, DEF } from '../store/useStore.js'
import { EXDB, EXIDX } from '../lib/exercises.js'
import {
  DayAssign,
  DayOverride,
  ExercisePicker,
  ExConfig,
  matchesKindFilter,
  toggleDayAssignSession,
  clearDayAssignToRest,
  toggleDayOverrideSession,
  setDayOverrideRest,
  clearDayOverride
} from '../sheets.jsx'
import RoutineEdit, { deleteRoutineFromState } from './RoutineEdit.jsx'

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

describe('Multi-session Plan, DayAssign/DayOverride, & Modality-aware Routine Editor (Issue #94)', () => {
  beforeEach(() => {
    localStorage.clear()
    useStore.setState({
      S: JSON.parse(JSON.stringify(DEF)),
      user: null
    })
  })

  describe('DayAssign multi-select & cp.day sync', () => {
    it('toggles multiple routines & cardio plans into week[day] arrays and handles scalar strings', () => {
      const state = {
        routines: [
          { id: 'r-push', name: 'Push', kind: 'gym', ex: [] },
          { id: 'r-yoga', name: 'Yoga Flow', kind: 'yoga', ex: [] }
        ],
        cardioPlans: [
          { id: 'cp-run', type: 'run', day: 3, targetDistanceM: 5000 }
        ],
        cardioActivities: [],
        week: {
          1: 'r-push',     // backward-compatible scalar string
          3: ['cp-run']    // old day for cp-run
        }
      }

      // Toggle on Guided Flow on Monday (currently scalar 'r-push')
      toggleDayAssignSession(state, 1, 'r-yoga')
      expect(state.week[1]).toEqual(['r-push', 'r-yoga'])

      // Toggle on cp-run on Monday -> moves cp.day from 3 to 1 and cleans stale week[3]
      toggleDayAssignSession(state, 1, 'cp-run')
      expect(state.week[1]).toEqual(['r-push', 'r-yoga', 'cp-run'])
      expect(state.cardioPlans[0].day).toBe(1)
      expect(state.week[3]).toBeUndefined()

      // Toggle off cp-run on Monday -> sets cp.day = null
      toggleDayAssignSession(state, 1, 'cp-run')
      expect(state.week[1]).toEqual(['r-push', 'r-yoga'])
      expect(state.cardioPlans[0].day).toBeNull()

      // Clear Monday to Rest -> removes week[1] and clears any cp.day === 1
      toggleDayAssignSession(state, 1, 'cp-run')
      expect(state.cardioPlans[0].day).toBe(1)
      clearDayAssignToRest(state, 1)
      expect(state.week[1]).toBeUndefined()
      expect(state.cardioPlans[0].day).toBeNull()
    })

    it('renders Strength, Guided Flow, Cardio Activity sections and Rest action in DayAssign', () => {
      useStore.setState({
        S: {
          ...JSON.parse(JSON.stringify(DEF)),
          routines: [
            { id: 'r-push', name: 'Push Day', emoji: 'dumbbell', kind: 'gym', ex: [{ id: '0001' }] },
            { id: 'r-mob', name: 'Hip Mobility', emoji: 'stretch', kind: 'mobility', ex: [{ id: '1512' }] }
          ],
          cardioPlans: [
            { id: 'cp-1', type: 'run', day: 1, targetDistanceM: 5000, notes: 'Easy' }
          ],
          week: { 1: 'r-push' } // scalar string should still mark Push Day checked
        }
      })

      const html = renderToStaticMarkup(
        React.createElement(DayAssign, { day: 1, close: () => {} })
      )
      expect(html).toContain('Monday')
      expect(html).toContain('Strength')
      expect(html).toContain('Push Day')
      expect(html).toContain('Guided Flow')
      expect(html).toContain('Hip Mobility')
      expect(html).toContain('Cardio Activity')
      expect(html).toContain('Run · 5 km')
      expect(html).toContain('Rest day')
      expect(html).toContain('Done')
    })
  })

  describe('DayOverride multi-select & effectiveDaySessions integration', () => {
    it('toggles sessions starting from effective weekly plan and supports __rest__ / reset', () => {
      const state = {
        routines: [
          { id: 'r-push', name: 'Push', kind: 'gym', ex: [] },
          { id: 'r-hiit', name: 'HIIT Burn', kind: 'hiit', ex: [] }
        ],
        cardioPlans: [
          { id: 'cp-run', type: 'run', day: 1, targetDistanceM: 5000 }
        ],
        week: { 1: ['r-push', 'cp-run'] }, // 2026-11-16 is Monday (1)
        dayPlan: {}
      }

      // Adding r-hiit on top of weekly plan preserves weekly r-push & cp-run
      toggleDayOverrideSession(state, '2026-11-16', 'r-hiit')
      expect(state.dayPlan['2026-11-16']).toEqual(['r-push', 'cp-run', 'r-hiit'])
      expect(state.cardioPlans[0].day).toBe(1) // cp.day untouched by single-day override

      // Removing all items sets ['__rest__'] sentinel instead of falling back to weekly plan
      toggleDayOverrideSession(state, '2026-11-16', 'r-push')
      toggleDayOverrideSession(state, '2026-11-16', 'cp-run')
      toggleDayOverrideSession(state, '2026-11-16', 'r-hiit')
      expect(state.dayPlan['2026-11-16']).toEqual(['__rest__'])

      // Clear override goes back to weekly plan
      clearDayOverride(state, '2026-11-16')
      expect(state.dayPlan['2026-11-16']).toBeUndefined()

      // Explicit rest override
      setDayOverrideRest(state, '2026-11-16')
      expect(state.dayPlan['2026-11-16']).toEqual(['__rest__'])
    })

    it('renders all weekly routines and cardio plans in DayOverride subtitle and groups', () => {
      useStore.setState({
        S: {
          ...JSON.parse(JSON.stringify(DEF)),
          routines: [
            { id: 'r-push', name: 'Push', emoji: 'dumbbell', kind: 'gym', ex: [] },
            { id: 'r-yoga', name: 'Yoga', emoji: 'sparkles', kind: 'yoga', ex: [] }
          ],
          cardioPlans: [
            { id: 'cp-run', type: 'run', day: 1, targetDistanceM: 5000 }
          ],
          week: { 1: ['r-push', 'r-yoga'] },
          dayPlan: { '2026-11-16': 'r-yoga' }
        }
      })

      const html = renderToStaticMarkup(
        React.createElement(DayOverride, { iso: '2026-11-16', close: () => {} })
      )
      expect(html).toContain('Push + Yoga + Run · 5 km')
      expect(html).toContain('changed for this day')
      expect(html).toContain('Rest / skip this day')
      expect(html).toContain('Back to weekly plan')
    })
  })

  describe('ExercisePicker kind pre-filter', () => {
    it('matchesKindFilter filters yoga, mobility, hiit, and allows all for gym', () => {
      const yogaEx = EXIDX['yoga-1']
      const stretchEx = EXIDX['1512']
      const cardioEx = EXIDX['3220']
      const plyoEx = EXIDX['fedb-alternate_leg_diagonal_bound']
      const strengthEx = EXIDX['0001']

      expect(matchesKindFilter(yogaEx, 'yoga')).toBe(true)
      expect(matchesKindFilter(strengthEx, 'yoga')).toBe(false)

      expect(matchesKindFilter(stretchEx, 'mobility')).toBe(true)
      expect(matchesKindFilter(strengthEx, 'mobility')).toBe(false)

      expect(matchesKindFilter(cardioEx, 'hiit')).toBe(true)
      expect(matchesKindFilter(plyoEx, 'hiit')).toBe(true)
      expect(matchesKindFilter(strengthEx, 'hiit')).toBe(false)

      expect(matchesKindFilter(strengthEx, 'gym')).toBe(true)
      expect(matchesKindFilter(yogaEx, undefined)).toBe(true)
    })

    it('renders kind filter pill and All toggle pill when kind is provided', () => {
      const yogaCount = EXDB.filter(e => e.cat === 'yoga').length
      const yogaHtml = renderToStaticMarkup(
        React.createElement(ExercisePicker, { kind: 'yoga', onPick: () => {}, close: () => {} })
      )
      expect(yogaHtml).toContain(`Search ${yogaCount} exercises`)
      expect(yogaHtml).toContain('chip on">Yoga')
      expect(yogaHtml).toContain('>All</button>')

      const gymHtml = renderToStaticMarkup(
        React.createElement(ExercisePicker, { kind: 'gym', onPick: () => {}, close: () => {} })
      )
      expect(gymHtml).toContain(`Search ${EXDB.length} exercises`)
      expect(gymHtml).toContain('chip nocap on">All</button>')
    })
  })

  describe('ExConfig modality-aware defaults & progression visibility', () => {
    it('defaults to timed mode (Seconds) for non-gym routine even when isCardio(ex.id) is true', () => {
      const cardioEx = EXIDX['3220']
      const hiitRoutine = { id: 'r-hiit', name: 'HIIT', kind: 'hiit', ex: [] }
      const html = renderToStaticMarkup(
        React.createElement(ExConfig, {
          ex: cardioEx,
          existing: null,
          routine: hiitRoutine,
          onSave: () => {},
          close: () => {}
        })
      )
      expect(html).toContain('Seconds')
      expect(html).not.toContain('Speed (km/h)')
      expect(html).not.toContain('Minutes')
    })

    it('hides strength reps progression selector when kind !== gym, but shows it for gym', () => {
      const strengthEx = EXIDX['0001']
      const yogaRoutine = { id: 'r-yoga', name: 'Yoga', kind: 'yoga', ex: [] }
      const gymRoutine = { id: 'r-gym', name: 'Push', kind: 'gym', ex: [] }

      const yogaRepsHtml = renderToStaticMarkup(
        React.createElement(ExConfig, {
          ex: strengthEx,
          existing: { sets: 3, mode: 'reps', reps: 10, weight: 0 },
          routine: yogaRoutine,
          onSave: () => {},
          close: () => {}
        })
      )
      expect(yogaRepsHtml).not.toContain('Linear progression')
      expect(yogaRepsHtml).not.toContain('Progression')

      const gymRepsHtml = renderToStaticMarkup(
        React.createElement(ExConfig, {
          ex: strengthEx,
          existing: null,
          routine: gymRoutine,
          onSave: () => {},
          close: () => {}
        })
      )
      expect(gymRepsHtml).toContain('Progression')
      expect(gymRepsHtml).toContain('Rule')
    })
  })

  describe('RoutineEdit modality hiding & array-safe routine deletion', () => {
    it('shows Progression and BodyMap for gym routines, and hides them for hiit/yoga/mobility', () => {
      const renderEdit = routine => {
        useStore.setState({
          S: {
            ...JSON.parse(JSON.stringify(DEF)),
            routines: [routine]
          }
        })
        return renderToStaticMarkup(
          React.createElement(
            MemoryRouter,
            { initialEntries: [`/plan/r/${routine.id}`] },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, { path: '/plan/r/:id', element: React.createElement(RoutineEdit) })
            )
          )
        )
      }

      const gymHtml = renderEdit({
        id: 'r-gym',
        name: 'Push',
        kind: 'gym',
        ex: [{ id: '0001', sets: 3, mode: 'reps', reps: 10, weight: 20 }]
      })
      expect(gymHtml).toContain('Progression')
      expect(gymHtml).toContain('What this session hits')

      for (const kind of ['hiit', 'yoga', 'mobility']) {
        const flowHtml = renderEdit({
          id: `r-${kind}`,
          name: `My ${kind}`,
          kind,
          ex: [{ id: '0001', sets: 3, mode: 'time', sec: 45, weight: 0 }]
        })
        expect(flowHtml).not.toContain('Progression')
        expect(flowHtml).not.toContain('What this session hits')
      }
    })

    it('deleteRoutineFromState removes routine id from array and scalar week/dayPlan entries and deletes empty keys', () => {
      const state = {
        routines: [
          { id: 'r1', name: 'Push', ex: [] },
          { id: 'r2', name: 'Yoga', ex: [] }
        ],
        week: {
          1: ['r1', 'r2'],
          3: ['r1'],
          5: 'r1'
        },
        dayPlan: {
          '2026-11-16': ['r1', 'cp-1'],
          '2026-11-17': ['r1'],
          '2026-11-18': 'r1'
        }
      }

      deleteRoutineFromState(state, 'r1')
      expect(state.routines.map(r => r.id)).toEqual(['r2'])
      expect(state.week[1]).toEqual(['r2'])
      expect(state.week[3]).toBeUndefined()
      expect(state.week[5]).toBeUndefined()
      expect(state.dayPlan['2026-11-16']).toEqual(['cp-1'])
      expect(state.dayPlan['2026-11-17']).toBeUndefined()
      expect(state.dayPlan['2026-11-18']).toBeUndefined()
    })
  })
})
