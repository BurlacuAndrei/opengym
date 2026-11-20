import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import {
  FLOW_ROUTINE_KINDS,
  isFlowRoutine,
  formatMoveAnnouncement,
  createFlowMoves,
  createFlowPlayer,
  startActiveFlow,
  getActiveFlow,
  clearActiveFlow,
  subscribeActiveFlow,
} from './flow-player.js'
import FlowPlayer, { persistFlowCompletion } from '../views/FlowPlayer.jsx'
import RecordingView from '../views/RecordingView.jsx'
import { useStore, DEF } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { setNav } from './nav.js'
import { startFlow, beginWorkout, bwSheet } from '../sheets.jsx'

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

describe('flow-player (Issue #78)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllTimers()
  })

  describe('FLOW_ROUTINE_KINDS and isFlowRoutine', () => {
    it('defines supported flow routine kinds', () => {
      expect(FLOW_ROUTINE_KINDS).toEqual(['hiit', 'yoga', 'mobility'])
    })

    it('identifies flow routines correctly', () => {
      expect(isFlowRoutine('hiit')).toBe(true)
      expect(isFlowRoutine('yoga')).toBe(true)
      expect(isFlowRoutine('mobility')).toBe(true)
      expect(isFlowRoutine({ kind: 'hiit' })).toBe(true)
      expect(isFlowRoutine({ kind: 'yoga' })).toBe(true)
      expect(isFlowRoutine({ kind: 'mobility' })).toBe(true)

      expect(isFlowRoutine('gym')).toBe(false)
      expect(isFlowRoutine({ kind: 'gym' })).toBe(false)
      expect(isFlowRoutine(null)).toBe(false)
      expect(isFlowRoutine({})).toBe(false)
    })
  })

  describe('formatMoveAnnouncement', () => {
    it('formats TTS announcement matching Issue #78 specification verbatim', () => {
      // Issue #78 requirement: "Next move: Downward Dog. 30 seconds."
      const announcement = formatMoveAnnouncement('Downward Dog', 30)
      expect(announcement).toBe('Next move: Downward Dog. 30 seconds.')
    })

    it('formats announcement with different durations and move names', () => {
      expect(formatMoveAnnouncement('Warrior II', 45)).toBe('Next move: Warrior II. 45 seconds.')
      expect(formatMoveAnnouncement('High Knees', 20)).toBe('Next move: High Knees. 20 seconds.')
    })

    it('handles singular 1 second gracefully', () => {
      expect(formatMoveAnnouncement('Plank Hold', 1)).toBe('Next move: Plank Hold. 1 second.')
    })
  })

  describe('createFlowMoves', () => {
    it('returns empty array for invalid or empty routine', () => {
      expect(createFlowMoves(null)).toEqual([])
      expect(createFlowMoves({})).toEqual([])
      expect(createFlowMoves({ ex: [] })).toEqual([])
    })

    it('expands routine exercises into sequential flow moves with durations', () => {
      const routine = {
        id: 'r-yoga',
        name: 'Morning Yoga',
        kind: 'yoga',
        ex: [
          { id: 'pose-1', name: 'Downward Dog', sec: 30 },
          { id: 'pose-2', name: 'Cobra Pose', time: 45 },
          { id: 'pose-3', name: 'Childs Pose' }, // default duration fallback
        ]
      }

      const moves = createFlowMoves(routine)
      expect(moves).toHaveLength(3)

      expect(moves[0].name).toBe('Downward Dog')
      expect(moves[0].duration).toBe(30)
      expect(moves[0].setIndex).toBe(1)
      expect(moves[0].totalSets).toBe(1)

      expect(moves[1].name).toBe('Cobra Pose')
      expect(moves[1].duration).toBe(45)

      expect(moves[2].name).toBe('Childs Pose')
      expect(moves[2].duration).toBe(30) // default 30s
    })

    it('handles multiple sets for interval circuits', () => {
      const routine = {
        id: 'r-hiit',
        name: 'Tabata',
        kind: 'hiit',
        ex: [
          { id: 'm1', name: 'Burpees', sec: 20, sets: 2 },
          { id: 'm2', name: 'Jumping Jacks', sec: 30, sets: 1 }
        ]
      }

      const moves = createFlowMoves(routine)
      expect(moves).toHaveLength(3)
      expect(moves[0].name).toBe('Burpees')
      expect(moves[0].setIndex).toBe(1)
      expect(moves[0].totalSets).toBe(2)

      expect(moves[1].name).toBe('Burpees')
      expect(moves[1].setIndex).toBe(2)
      expect(moves[1].totalSets).toBe(2)

      expect(moves[2].name).toBe('Jumping Jacks')
      expect(moves[2].setIndex).toBe(1)
    })
  })

  describe('createFlowPlayer engine and interval progression', () => {
    const routine = {
      id: 'r-flow',
      name: 'Flow Routine',
      kind: 'yoga',
      ex: [
        { id: 'e1', name: 'Downward Dog', sec: 30 },
        { id: 'e2', name: 'Warrior II', sec: 20 }
      ]
    }

    it('initializes in idle state with first move ready', () => {
      const player = createFlowPlayer(routine)
      const state = player.getState()

      expect(state.status).toBe('idle')
      expect(state.currentIndex).toBe(0)
      expect(state.totalMoves).toBe(2)
      expect(state.currentMove.name).toBe('Downward Dog')
      expect(state.timeRemaining).toBe(30)
      expect(state.elapsed).toBe(0)
      expect(state.totalElapsed).toBe(0)
      expect(state.isPaused).toBe(false)
      expect(state.isCompleted).toBe(false)
    })

    it('speaks initial move announcement on start with ducking', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, { speak: mockSpeak })

      player.start()
      const state = player.getState()

      expect(state.status).toBe('playing')
      expect(mockSpeak).toHaveBeenCalledTimes(1)
      expect(mockSpeak).toHaveBeenCalledWith('Next move: Downward Dog. 30 seconds.', { ducking: true })
    })

    it('auto-advances interval progression on timer ticks and announces next move', () => {
      const mockSpeak = vi.fn()
      const onMoveChange = vi.fn()
      const onComplete = vi.fn()

      const player = createFlowPlayer(routine, {
        speak: mockSpeak,
        onMoveChange,
        onComplete
      })

      player.start()
      expect(mockSpeak).toHaveBeenCalledWith('Next move: Downward Dog. 30 seconds.', { ducking: true })

      // Advance 10 seconds into Downward Dog
      player.tick(10)
      let s = player.getState()
      expect(s.timeRemaining).toBe(20)
      expect(s.elapsed).toBe(10)
      expect(s.totalElapsed).toBe(10)
      expect(s.currentIndex).toBe(0)

      // Advance 20 more seconds to finish move 1 (total 30s)
      player.tick(20)
      s = player.getState()

      // Auto-advanced to move 2: Warrior II (20s)
      expect(s.currentIndex).toBe(1)
      expect(s.currentMove.name).toBe('Warrior II')
      expect(s.timeRemaining).toBe(20)
      expect(s.elapsed).toBe(0)
      expect(s.totalElapsed).toBe(30)

      // Verifies TTS announced transition to Warrior II
      expect(mockSpeak).toHaveBeenCalledTimes(2)
      expect(mockSpeak).toHaveBeenLastCalledWith('Next move: Warrior II. 20 seconds.', { ducking: true })
      expect(onMoveChange).toHaveBeenCalledTimes(1)

      // Advance 20 seconds to finish Warrior II (total 50s)
      player.tick(20)
      s = player.getState()

      // Workout complete
      expect(s.status).toBe('completed')
      expect(s.isCompleted).toBe(true)
      expect(s.timeRemaining).toBe(0)
      expect(s.totalElapsed).toBe(50)
      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    it('advances in real-time with setInterval timer', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, { speak: mockSpeak })

      player.start()
      expect(player.getState().timeRemaining).toBe(30)

      // Fast forward 5 seconds
      vi.advanceTimersByTime(5000)
      expect(player.getState().timeRemaining).toBe(25)
      expect(player.getState().totalElapsed).toBe(5)

      player.destroy()
    })
  })

  describe('player controls: pause, resume, skip, restartMove', () => {
    const routine = {
      id: 'r-mobility',
      name: 'Mobility Routine',
      kind: 'mobility',
      ex: [
        { id: 'm1', name: 'Cat Cow', sec: 30 },
        { id: 'm2', name: 'World Greatest Stretch', sec: 40 }
      ]
    }

    it('handles pause and resume controls and stops speaking on pause', () => {
      const mockSpeak = vi.fn()
      const mockStopSpeaking = vi.fn()

      const player = createFlowPlayer(routine, {
        speak: mockSpeak,
        stopSpeaking: mockStopSpeaking
      })

      player.start()
      player.tick(5)
      expect(player.getState().timeRemaining).toBe(25)
      expect(player.getState().isPlaying).toBe(true)

      // Pause
      player.pause()
      expect(player.getState().status).toBe('paused')
      expect(player.getState().isPaused).toBe(true)
      expect(mockStopSpeaking).toHaveBeenCalledTimes(1)

      // Timer ticks do nothing while paused
      player.tick(5)
      expect(player.getState().timeRemaining).toBe(25)

      // Resume
      player.resume()
      expect(player.getState().status).toBe('playing')
      expect(player.getState().isPaused).toBe(false)

      player.tick(5)
      expect(player.getState().timeRemaining).toBe(20)

      // Toggle pause
      player.togglePause()
      expect(player.getState().isPaused).toBe(true)
      player.togglePause()
      expect(player.getState().isPlaying).toBe(true)

      player.destroy()
    })

    it('skip advances immediately to next move and announces it', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, { speak: mockSpeak })

      player.start()
      expect(mockSpeak).toHaveBeenCalledWith('Next move: Cat Cow. 30 seconds.', { ducking: true })

      // User taps skip button
      player.skip()
      const s = player.getState()

      expect(s.currentIndex).toBe(1)
      expect(s.currentMove.name).toBe('World Greatest Stretch')
      expect(s.timeRemaining).toBe(40)
      expect(s.elapsed).toBe(0)

      expect(mockSpeak).toHaveBeenCalledTimes(2)
      expect(mockSpeak).toHaveBeenLastCalledWith('Next move: World Greatest Stretch. 40 seconds.', { ducking: true })

      // Skip on last move completes workout
      player.skip()
      expect(player.getState().status).toBe('completed')
      expect(player.getState().isCompleted).toBe(true)
    })

    it('restartMove resets the countdown of the current move to its beginning', () => {
      const player = createFlowPlayer(routine)
      player.start()

      // Advance 15 seconds
      player.tick(15)
      expect(player.getState().timeRemaining).toBe(15)
      expect(player.getState().elapsed).toBe(15)

      // Restart move
      player.restartMove()
      const s = player.getState()

      expect(s.timeRemaining).toBe(30)
      expect(s.elapsed).toBe(0)
      expect(s.currentIndex).toBe(0)
    })

    it('previous navigates back to the preceding move and announces it', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, { speak: mockSpeak })

      player.start()
      player.skip()
      expect(player.getState().currentIndex).toBe(1)

      player.previous()
      expect(player.getState().currentIndex).toBe(0)
      expect(player.getState().currentMove.name).toBe('Cat Cow')
      expect(mockSpeak).toHaveBeenLastCalledWith('Next move: Cat Cow. 30 seconds.', { ducking: true })
    })

    it('suppresses speech announcements when voiceCues is false', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, {
        speak: mockSpeak,
        voiceCues: false
      })

      player.start()
      expect(mockSpeak).not.toHaveBeenCalled()

      player.skip()
      expect(mockSpeak).not.toHaveBeenCalled()
    })
  })

  describe('FlowPlayer React view rendering', () => {
    it('renders empty placeholder if routine has no exercises', () => {
      const html = renderToStaticMarkup(
        React.createElement(MemoryRouter, null,
          React.createElement(FlowPlayer, { routine: { id: 'r-empty', name: 'Empty Routine', ex: [] } })
        )
      )
      expect(html).toContain('No exercises in this routine')
    })

    it('renders active move, kind badge, countdown timer, and control buttons', () => {
      const routine = {
        id: 'r-yoga',
        name: 'Morning Yoga',
        kind: 'yoga',
        ex: [
          { id: 'pose-1', name: 'Downward Dog', sec: 30 },
          { id: 'pose-2', name: 'Warrior II', sec: 45 }
        ]
      }

      const html = renderToStaticMarkup(
        React.createElement(MemoryRouter, null,
          React.createElement(FlowPlayer, { routine })
        )
      )

      expect(html).toContain('Morning Yoga')
      expect(html).toContain('Yoga')
      expect(html).toContain('Downward Dog')
      expect(html).toContain('0:30')
      expect(html).toContain('Up next: Warrior II (45s)')
      expect(html).toContain('Restart move')
      expect(html).toContain('Skip move')
    })

    it('resolves routine by :id param on /flow/:id route (Issue #93)', () => {
      useStore.getInitialState = () => useStore.getState()
      useStore.setState({
        S: {
          ...JSON.parse(JSON.stringify(DEF)),
          routines: [
            {
              id: 'r-mob-route',
              name: 'Hip Mobility',
              kind: 'mobility',
              ex: [{ id: 'm1', name: 'Pigeon Stretch', sec: 40 }],
            },
          ],
        },
      })

      const html = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/flow/r-mob-route'] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, { path: '/flow/:id', element: React.createElement(FlowPlayer) })
          )
        )
      )
      expect(html).toContain('Hip Mobility')
      expect(html).toContain('Mobility')
      expect(html).toContain('Pigeon Stretch')
    })
  })

  describe('Shared active-flow controller, dispatch & persistence (Issue #93)', () => {
    beforeEach(() => {
      clearActiveFlow()
      useUI.getState().closeAll()
      useStore.setState({
        S: JSON.parse(JSON.stringify(DEF)),
        user: { id: 'u1', name: 'Tester' },
      })
    })

    afterEach(() => {
      clearActiveFlow()
      useUI.getState().closeAll()
    })

    it('tracks active flow, notifies subscribers, reuses across tab navigation, and clears on stop/complete', () => {
      const routine = {
        id: 'r-hiit-active',
        name: 'Tabata Circuit',
        kind: 'hiit',
        ex: [
          { id: 'e1', name: 'Burpees', sec: 20 },
          { id: 'e2', name: 'Squat Jumps', sec: 20 },
        ],
      }

      const events = []
      const unsub = subscribeActiveFlow(f => events.push(f ? f.routineId : null))

      const f1 = startActiveFlow(routine, { voiceCues: false })
      expect(f1).not.toBeNull()
      expect(f1.routineId).toBe('r-hiit-active')
      expect(f1.kind).toBe('hiit')
      expect(getActiveFlow()?.routineId).toBe('r-hiit-active')

      // Re-entering for same routine reuses the active player instance (survives tab switch)
      f1.player.tick(5)
      const f2 = startActiveFlow(routine, { voiceCues: false })
      expect(f2.player).toBe(f1.player)
      expect(f2.state.timeRemaining).toBe(15)

      // Completing flow clears getActiveFlow()
      f1.player.skip()
      f1.player.skip()
      expect(getActiveFlow()).toBeNull()

      // Starting again and calling clearActiveFlow() destroys & notifies null
      const f3 = startActiveFlow(routine, { voiceCues: false })
      expect(getActiveFlow()).not.toBeNull()
      clearActiveFlow()
      expect(getActiveFlow()).toBeNull()
      expect(events[events.length - 1]).toBeNull()
      unsub()
    })

    it('does not leave an active flow dangling for empty or missing routines', () => {
      expect(startActiveFlow(null)).toBeNull()
      expect(getActiveFlow()).toBeNull()
      expect(startActiveFlow({ id: 'r-empty', name: 'Empty', kind: 'yoga', ex: [] })).toBeNull()
      expect(getActiveFlow()).toBeNull()
    })

    it('persists completed Flow Session into S.freestyleSessions with durationMs >= 1000 and clears active flow', () => {
      const routine = {
        id: 'r-yoga-save',
        name: 'Evening Yoga',
        kind: 'yoga',
        ex: [{ id: 'p1', name: 'Child Pose', sec: 30 }],
      }
      startActiveFlow(routine, { voiceCues: false })
      expect(getActiveFlow()).not.toBeNull()

      // Fast-skip (totalElapsed === 0) must clamp durationMs >= 1000ms
      const saved = persistFlowCompletion({
        routine,
        kind: 'yoga',
        totalElapsed: 0,
        rpe: 7,
        startedAt: Date.now() - 5000,
      })

      expect(saved.routineId).toBe('r-yoga-save')
      expect(saved.name).toBe('Evening Yoga')
      expect(saved.kind).toBe('yoga')
      expect(saved.durationMs).toBe(1000)
      expect(saved.rpe).toBe(7)
      expect(saved.load).toBeGreaterThan(0)
      expect(getActiveFlow()).toBeNull()

      const stored = useStore.getState().S.freestyleSessions
      expect(stored).toHaveLength(1)
      expect(stored[0].id).toBe(saved.id)
      expect(stored[0].routineId).toBe('r-yoga-save')
    })

    it('startFlow dispatches 1-tap by modality without mandatory bw modal and auto-attaches latest bw', () => {
      const navMock = vi.fn()
      setNav(navMock)

      useStore.setState({
        S: {
          ...JSON.parse(JSON.stringify(DEF)),
          bodyweight: [{ d: '2026-11-18', w: 78.5, t: 1000 }],
          routines: [
            { id: 'r-gym-1', name: 'Push Day', kind: 'gym', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] },
            { id: 'r-hiit-1', name: 'HIIT Day', kind: 'hiit', ex: [{ id: 'm1', name: 'Burpees', sec: 30 }] },
          ],
        },
      })

      // 1. Flow routine -> /flow/:id without opening bwSheet or creating S.active
      startFlow('r-hiit-1')
      expect(useUI.getState().sheets).toHaveLength(0)
      expect(useStore.getState().S.active).toBeNull()
      expect(navMock).toHaveBeenCalledWith('/flow/r-hiit-1')

      // 2. Gym routine -> creates S.active with auto-attached latest bw and navigates to /workout
      navMock.mockClear()
      startFlow('r-gym-1')
      expect(useUI.getState().sheets).toHaveLength(0)
      expect(useStore.getState().S.active).not.toBeNull()
      expect(useStore.getState().S.active.routineId).toBe('r-gym-1')
      expect(useStore.getState().S.active.bw).toBe(78.5)
      expect(navMock).toHaveBeenCalledWith('/workout')

      // 3. Ad-hoc freestyle strength -> creates S.active with null routineId and latest bw
      useStore.getState().update(s => { s.active = null })
      navMock.mockClear()
      startFlow(null)
      expect(useStore.getState().S.active.routineId).toBeNull()
      expect(useStore.getState().S.active.bw).toBe(78.5)
      expect(navMock).toHaveBeenCalledWith('/workout')

      // 4. beginWorkout explicit bw null preserves null
      useStore.getState().update(s => { s.active = null })
      beginWorkout('r-gym-1', null)
      expect(useStore.getState().S.active.bw).toBeNull()

      // 5. Manual bwSheet() still opens sheet intact
      bwSheet()
      expect(useUI.getState().sheets).toHaveLength(1)
    })

    it('RecordingView preselects sport from location.state.activityType when idle', () => {
      const html = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          { initialEntries: [{ pathname: '/record', state: { activityType: 'ride' } }] },
          React.createElement(RecordingView)
        )
      )
      expect(html).toContain('Start ride')
    })

    it('does not restart active flow or duplicate freestyleSessions when useStore.update() clones S.routines on completion', async () => {
      vi.resetModules()

      const hooks = []
      let hookIdx = 0
      let dirty = true
      let pendingEffects = []
      let currentRouteId = 'r-flow-regress'

      const depsChanged = (prev, next) =>
        !prev || !next || prev.length !== next.length || next.some((d, i) => !Object.is(d, prev[i]))

      vi.doMock('react', async importOriginal => {
        const actual = await importOriginal()
        return {
          ...actual,
          useState(init) {
            const idx = hookIdx++
            if (hooks[idx] === undefined) {
              hooks[idx] = typeof init === 'function' ? init() : init
            }
            const setState = val => {
              const next = typeof val === 'function' ? val(hooks[idx]) : val
              if (!Object.is(hooks[idx], next)) {
                hooks[idx] = next
                dirty = true
              }
            }
            return [hooks[idx], setState]
          },
          useRef(init) {
            const idx = hookIdx++
            if (hooks[idx] === undefined) {
              hooks[idx] = { current: init }
            }
            return hooks[idx]
          },
          useMemo(fn, deps) {
            const idx = hookIdx++
            const prev = hooks[idx]
            if (!prev || depsChanged(prev.deps, deps)) {
              hooks[idx] = { value: fn(), deps }
            }
            return hooks[idx].value
          },
          useCallback(fn, deps) {
            const idx = hookIdx++
            const prev = hooks[idx]
            if (!prev || depsChanged(prev.deps, deps)) {
              hooks[idx] = { value: fn, deps }
            }
            return hooks[idx].value
          },
          useEffect(fn, deps) {
            const idx = hookIdx++
            const prev = hooks[idx]
            if (!prev || depsChanged(prev.deps, deps)) {
              pendingEffects.push({ idx, fn, deps })
            }
          },
        }
      })

      vi.doMock('react-router-dom', async importOriginal => {
        const actual = await importOriginal()
        return {
          ...actual,
          useNavigate: () => vi.fn(),
          useParams: () => ({ id: currentRouteId }),
          useLocation: () => ({ state: null }),
        }
      })

      vi.doMock('../lib/wakelock.js', () => ({
        useWakeLock: vi.fn(),
      }))

      try {
        const { useStore: storeMod, DEF: defMod } = await import('../store/useStore.js')
        const { getActiveFlow: getFlow, clearActiveFlow: clearFlow } = await import('./flow-player.js')
        const { default: FlowPlayerComp } = await import('../views/FlowPlayer.jsx')

        clearFlow()
        storeMod.setState({
          S: {
            ...JSON.parse(JSON.stringify(defMod)),
            voiceCues: true,
            routines: [
              { id: 'r-flow-regress', name: 'Regression Yoga', kind: 'yoga', ex: [{ id: 'p1', name: 'Pose 1', sec: 20 }] },
              { id: 'r-flow-regress-2', name: 'Second Flow', kind: 'hiit', ex: [{ id: 'p2', name: 'Burpees', sec: 20 }] },
            ],
          },
          user: { id: 'u1', name: 'Tester' },
        })

        const flushRender = () => {
          dirty = true
          for (let i = 0; i < 20 && dirty; i++) {
            dirty = false
            hookIdx = 0
            pendingEffects = []
            FlowPlayerComp({})
            const effects = pendingEffects
            pendingEffects = []
            for (const eff of effects) {
              const prev = hooks[eff.idx]
              if (prev?.cleanup) prev.cleanup()
              const cleanup = eff.fn()
              hooks[eff.idx] = { deps: eff.deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
            }
          }
        }

        // 1. Initial mount starts the active flow
        flushRender()
        const initialFlow = getFlow()
        expect(initialFlow).not.toBeNull()
        expect(initialFlow.routineId).toBe('r-flow-regress')
        const initialPlayer = initialFlow.player
        const initialRoutineRef = storeMod.getState().S.routines[0]

        // 2. Updating voiceCues (which also clones S.routines) must NOT wipe/restart active player
        storeMod.getState().update(s => { s.voiceCues = false })
        flushRender()
        expect(storeMod.getState().S.routines[0]).not.toBe(initialRoutineRef)
        expect(getFlow()?.player).toBe(initialPlayer)

        // 3. Completing the flow persists 1 entry (cloning S.routines) and clears active flow permanently
        initialPlayer.skip()
        flushRender()
        expect(getFlow()).toBeNull()
        expect(storeMod.getState().S.freestyleSessions).toHaveLength(1)
        expect(storeMod.getState().S.freestyleSessions[0].routineId).toBe('r-flow-regress')

        // 4. Subsequent store updates cloning S.routines must NOT restart active flow or duplicate persistence
        storeMod.getState().update(s => { s.routines[0].name = 'Renamed After Done' })
        flushRender()
        expect(getFlow()).toBeNull()
        expect(storeMod.getState().S.freestyleSessions).toHaveLength(1)

        // 5. Navigating to a different routine id still initializes the new flow cleanly
        currentRouteId = 'r-flow-regress-2'
        flushRender()
        expect(getFlow()?.routineId).toBe('r-flow-regress-2')
        clearFlow()
      } finally {
        vi.doUnmock('../lib/wakelock.js')
        vi.doUnmock('react')
        vi.doUnmock('react-router-dom')
        vi.resetModules()
      }
    })
  })
})
