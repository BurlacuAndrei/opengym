import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import StartHubSheet, { openStartHubSheet, getPendingDaySessions } from './StartHubSheet.jsx'
import TabBar, { resolveTabBarResume } from './TabBar.jsx'
import { useStore, DEF } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { todayISO } from '../lib/format.js'
import { getCardioRecorder, RECORDING_STATUS } from '../lib/cardio-recording.js'
import { startActiveFlow, clearActiveFlow } from '../lib/flow-player.js'

vi.mock('../store/useStore.js', async importOriginal => {
  const actual = await importOriginal()
  const useStoreMock = selector => {
    const s = actual.useStore.getState()
    return selector ? selector(s) : s
  }
  Object.assign(useStoreMock, actual.useStore)
  return { ...actual, useStore: useStoreMock }
})

if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
  }
}

describe('StartHubSheet & TabBar (Issue #93)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    clearActiveFlow()
    useUI.getState().closeAll()
    useStore.getInitialState = () => useStore.getState()
    useStore.setState({
      S: JSON.parse(JSON.stringify(DEF)),
      user: { id: 'u1', name: 'Tester' },
    })
  })

  afterEach(async () => {
    clearActiveFlow()
    const rec = getCardioRecorder()
    if (!rec.isIdle) {
      await rec.discardRecording()
    }
    useUI.getState().closeAll()
    vi.restoreAllMocks()
    vi.clearAllTimers()
  })

  describe('StartHubSheet planned sessions & 5 quick actions', () => {
    it('shows uncompleted planned routines & cardioPlans at top, excluding completed ones', () => {
      const today = todayISO()
      const wd = new Date(today + 'T12:00:00').getDay()

      useStore.setState({
        S: {
          ...JSON.parse(JSON.stringify(DEF)),
          routines: [
            { id: 'r-gym-done', name: 'Push Done', kind: 'gym', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] },
            { id: 'r-flow-done', name: 'Yoga Done', kind: 'yoga', ex: [{ id: 'p1', name: 'Cat Cow', sec: 30 }] },
            { id: 'r-hiit-todo', name: 'HIIT Pending', kind: 'hiit', ex: [{ id: 'p2', name: 'Burpees', sec: 30 }] },
          ],
          cardioPlans: [
            { id: 'cp-done', type: 'run', day: wd, targetDistanceM: 5000, completed: true },
            { id: 'cp-todo', type: 'ride', day: wd, targetDistanceM: 15000, completed: false, notes: 'Zone 2 ride' },
          ],
          week: { [wd]: ['r-gym-done', 'r-flow-done', 'r-hiit-todo'] },
          workouts: [{ id: 'w1', d: today, routineId: 'r-gym-done', entries: [] }],
          freestyleSessions: [{ id: 'fs1', kind: 'yoga', routineId: 'r-flow-done', durationMs: 60000, rpe: 6, startTime: `${today}T09:00:00Z` }],
        }
      })

      const { pendingRoutines, pendingCardio } = getPendingDaySessions(useStore.getState().S, today)
      expect(pendingRoutines.map(r => r.id)).toEqual(['r-hiit-todo'])
      expect(pendingCardio.map(cp => cp.id)).toEqual(['cp-todo'])

      const html = renderToStaticMarkup(
        React.createElement(MemoryRouter, null,
          React.createElement(StartHubSheet, { close: vi.fn() })
        )
      )

      expect(html).toContain("Today&#x27;s plan")
      expect(html).toContain('HIIT Pending')
      expect(html).toContain('Zone 2 ride')
      expect(html).not.toContain('Push Done')
      expect(html).not.toContain('Yoga Done')
      expect(html).not.toContain('planned-cardio-cp-done')

      // All 5 Quick Launch Actions rendered
      expect(html).toContain('Record GPS Cardio')
      expect(html).toContain('Start Strength Workout')
      expect(html).toContain('Start Guided Flow')
      expect(html).toContain('Log Manual Cardio')
      expect(html).toContain('Log Freestyle Session')
    })

    it('renders strength subview (gym routines + ad-hoc freestyle) and flow subview (hiit/yoga/mobility)', () => {
      useStore.setState({
        S: {
          ...JSON.parse(JSON.stringify(DEF)),
          routines: [
            { id: 'r-gym', name: 'Upper Gym', kind: 'gym', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] },
            { id: 'r-hiit', name: 'HIIT Blast', kind: 'hiit', ex: [{ id: 'm1', name: 'Burpees', sec: 20 }] },
            { id: 'r-yoga', name: 'Evening Yoga', kind: 'yoga', ex: [{ id: 'm2', name: 'Cobra', sec: 30 }] },
          ],
        }
      })

      const strengthHtml = renderToStaticMarkup(
        React.createElement(MemoryRouter, null,
          React.createElement(StartHubSheet, { close: vi.fn(), initialView: 'strength' })
        )
      )
      expect(strengthHtml).toContain('Upper Gym')
      expect(strengthHtml).not.toContain('HIIT Blast')
      expect(strengthHtml).toContain('Freestyle workout (pick as you go)')

      const flowHtml = renderToStaticMarkup(
        React.createElement(MemoryRouter, null,
          React.createElement(StartHubSheet, { close: vi.fn(), initialView: 'flow' })
        )
      )
      expect(flowHtml).toContain('HIIT Blast')
      expect(flowHtml).toContain('Evening Yoga')
      expect(flowHtml).not.toContain('Upper Gym')
    })

    it('openStartHubSheet opens StartHubSheet via useUI', () => {
      openStartHubSheet()
      expect(useUI.getState().sheets).toHaveLength(1)
      const el = useUI.getState().sheets[0].render(() => {})
      const html = renderToStaticMarkup(React.createElement(MemoryRouter, null, el))
      expect(html).toContain('Start a session')
    })
  })

  describe('TabBar Library label & Resume / Start hub states', () => {
    it('renders Library as the 5th tab and Start when idle', () => {
      const html = renderToStaticMarkup(
        React.createElement(MemoryRouter, null, React.createElement(TabBar))
      )
      expect(html).toContain('Library')
      expect(html).not.toContain('Exercises')
      expect(html).toContain('Start')
      expect(html).not.toContain('Resume')
    })

    it('resolves Resume targets and renders Resume for strength, cardio, and flow sessions', async () => {
      // 1. Strength active (S.active) -> /workout
      useStore.setState({
        S: {
          ...JSON.parse(JSON.stringify(DEF)),
          active: { id: 'a1', name: 'Push Day', entries: [] },
        }
      })
      expect(resolveTabBarResume({ S: useStore.getState().S, cardioState: null, activeFlow: null })).toEqual({
        target: '/workout',
        icon: 'dumbbell',
      })
      const workoutHtml = renderToStaticMarkup(
        React.createElement(MemoryRouter, null, React.createElement(TabBar))
      )
      expect(workoutHtml).toContain('Resume')
      expect(workoutHtml).toContain('class="start rec"')

      // Clear strength workout
      useStore.setState({ S: JSON.parse(JSON.stringify(DEF)) })

      // 2. Cardio recording / paused -> /record with ride or run icon
      const rec = getCardioRecorder()
      await rec.startRecording({ type: 'ride' })
      expect(resolveTabBarResume({ S: useStore.getState().S, cardioState: rec.getState(), activeFlow: null })).toEqual({
        target: '/record',
        icon: 'bike',
      })
      const cardioHtml = renderToStaticMarkup(
        React.createElement(MemoryRouter, null, React.createElement(TabBar))
      )
      expect(cardioHtml).toContain('Resume')
      expect(cardioHtml).toContain('class="start rec"')

      rec.pauseRecording()
      expect(resolveTabBarResume({ S: useStore.getState().S, cardioState: rec.getState(), activeFlow: null })).toEqual({
        target: '/record',
        icon: 'bike',
      })
      await rec.discardRecording()

      // 3. Flow Session playing / paused -> /flow/:id with modality icon
      const flow = startActiveFlow({
        id: 'r-yoga-1',
        name: 'Morning Yoga',
        kind: 'yoga',
        ex: [{ id: 'p1', name: 'Downward Dog', sec: 30 }]
      }, { voiceCues: false })
      expect(resolveTabBarResume({
        S: useStore.getState().S,
        cardioState: { status: RECORDING_STATUS.IDLE },
        activeFlow: flow,
      })).toEqual({
        target: '/flow/r-yoga-1',
        icon: 'sparkles',
      })

      const flowHtml = renderToStaticMarkup(
        React.createElement(MemoryRouter, null, React.createElement(TabBar))
      )
      expect(flowHtml).toContain('Resume')
      expect(flowHtml).toContain('class="start rec"')

      flow.player.pause()
      const flowPausedHtml = renderToStaticMarkup(
        React.createElement(MemoryRouter, null, React.createElement(TabBar))
      )
      expect(flowPausedHtml).toContain('Resume')

      clearActiveFlow()
      const idleHtml = renderToStaticMarkup(
        React.createElement(MemoryRouter, null, React.createElement(TabBar))
      )
      expect(idleHtml).toContain('Start')
      expect(idleHtml).not.toContain('Resume')
    })
  })
})
