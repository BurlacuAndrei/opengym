import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  FREESTYLE_MODALITIES,
  isValidModality,
  formatModality,
  formatTimerClock,
  validateFreestyleSession,
  calculateFreestyleLoad,
  createFreestyleSession,
  startFreestyleTimer,
  pauseFreestyleTimer,
  resumeFreestyleTimer,
  getFreestyleTimerElapsedMs,
  finishFreestyleTimer,
  logFreestyleSession,
  getFreestyleSessions,
  deleteFreestyleSession
} from './freestyle-session.js'
import FreestyleLoggerSheet, { openFreestyleLoggerSheet } from '../components/FreestyleLoggerSheet.jsx'
import { useStore, DEF } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

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

describe('Freestyle Timed Session Logger (Issue #70)', () => {
  beforeEach(() => {
    localStorage.clear()
    useStore.setState({
      S: JSON.parse(JSON.stringify(DEF)),
      user: null
    })
  })

  describe('Modalities and Validation', () => {
    it('defines supported modalities: hiit, yoga, mobility', () => {
      expect(FREESTYLE_MODALITIES).toEqual(['hiit', 'yoga', 'mobility'])
    })

    it('validates modalities correctly', () => {
      expect(isValidModality('hiit')).toBe(true)
      expect(isValidModality('yoga')).toBe(true)
      expect(isValidModality('mobility')).toBe(true)
      expect(isValidModality('HIIT')).toBe(true)
      expect(isValidModality(' Yoga ')).toBe(true)
      expect(isValidModality('running')).toBe(false)
      expect(isValidModality('pilates')).toBe(false)
      expect(isValidModality(null)).toBe(false)
      expect(isValidModality('')).toBe(false)
    })

    it('formats modalities for display', () => {
      expect(formatModality('hiit')).toBe('HIIT')
      expect(formatModality('yoga')).toBe('Yoga')
      expect(formatModality('mobility')).toBe('Mobility')
      expect(formatModality('')).toBe('')
    })

    it('validates correct freestyle session payload', () => {
      const valid = {
        kind: 'hiit',
        durationMs: 1800000, // 30 min
        rpe: 8,
        notes: 'Intense sprint intervals'
      }
      const res = validateFreestyleSession(valid)
      expect(res.valid).toBe(true)
      expect(res.errors).toEqual([])
    })

    it('rejects invalid or non-object payloads', () => {
      expect(validateFreestyleSession(null).valid).toBe(false)
      expect(validateFreestyleSession('string').valid).toBe(false)
      expect(validateFreestyleSession(undefined).valid).toBe(false)
    })

    it('requires valid modality kind', () => {
      const res = validateFreestyleSession({ kind: 'crossfit', durationMs: 1000, rpe: 7 })
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toContain('Modality kind must be one of')
    })

    it('requires positive durationMs', () => {
      expect(validateFreestyleSession({ kind: 'yoga', durationMs: 0, rpe: 5 }).valid).toBe(false)
      expect(validateFreestyleSession({ kind: 'yoga', durationMs: -500, rpe: 5 }).valid).toBe(false)
      expect(validateFreestyleSession({ kind: 'yoga', durationMs: NaN, rpe: 5 }).valid).toBe(false)
    })

    it('requires RPE to be between 1 and 10', () => {
      expect(validateFreestyleSession({ kind: 'mobility', durationMs: 60000, rpe: 0 }).valid).toBe(false)
      expect(validateFreestyleSession({ kind: 'mobility', durationMs: 60000, rpe: 11 }).valid).toBe(false)
      expect(validateFreestyleSession({ kind: 'mobility', durationMs: 60000, rpe: 7.5 }).valid).toBe(true)
    })

    it('validates notes type if provided', () => {
      expect(validateFreestyleSession({ kind: 'mobility', durationMs: 60000, rpe: 6, notes: 123 }).valid).toBe(false)
      expect(validateFreestyleSession({ kind: 'mobility', durationMs: 60000, rpe: 6, notes: 'Good stretch' }).valid).toBe(true)
    })
  })

  describe('sRPE Training Load Calculation', () => {
    it('calculates session load (duration minutes * RPE)', () => {
      // 30 min (1,800,000 ms) * RPE 7 = 210 AU
      expect(calculateFreestyleLoad({ durationMs: 1800000, rpe: 7 })).toBe(210)

      // 45 min (2,700,000 ms) * RPE 6 = 270 AU
      expect(calculateFreestyleLoad({ durationMs: 2700000, rpe: 6 })).toBe(270)

      // 20 min (1,200,000 ms) * RPE 8.5 = 170 AU
      expect(calculateFreestyleLoad({ durationMs: 1200000, rpe: 8.5 })).toBe(170)

      // 15.5 min (930,000 ms) * RPE 9 = 139.5 AU
      expect(calculateFreestyleLoad({ durationMs: 930000, rpe: 9 })).toBe(139.5)
    })

    it('returns 0 for invalid duration or RPE', () => {
      expect(calculateFreestyleLoad(null)).toBe(0)
      expect(calculateFreestyleLoad({ durationMs: 0, rpe: 7 })).toBe(0)
      expect(calculateFreestyleLoad({ durationMs: -1000, rpe: 7 })).toBe(0)
      expect(calculateFreestyleLoad({ durationMs: 60000, rpe: 0 })).toBe(0)
      expect(calculateFreestyleLoad({ durationMs: 60000, rpe: -5 })).toBe(0)
    })

    it('automatically attaches calculated load when creating freestyle session', () => {
      const session = createFreestyleSession({
        kind: 'hiit',
        durationMs: 1200000, // 20 min
        rpe: 8,
        notes: 'Morning tabata'
      })
      expect(session.id).toBeDefined()
      expect(session.kind).toBe('hiit')
      expect(session.durationMs).toBe(1200000)
      expect(session.rpe).toBe(8)
      expect(session.load).toBe(160) // 20 * 8
      expect(session.notes).toBe('Morning tabata')
    })
  })

  describe('Timer Clock Formatting', () => {
    it('formats seconds and minutes into MM:SS', () => {
      expect(formatTimerClock(0)).toBe('00:00')
      expect(formatTimerClock(5000)).toBe('00:05')
      expect(formatTimerClock(65000)).toBe('01:05')
      expect(formatTimerClock(599000)).toBe('09:59')
    })

    it('formats hours into HH:MM:SS', () => {
      expect(formatTimerClock(3600000)).toBe('01:00:00')
      expect(formatTimerClock(3665000)).toBe('01:01:05')
    })
  })

  describe('Timed Session State Machine (Start, Pause, Resume, Finish)', () => {
    it('starts timer in running state', () => {
      const t0 = 1000000
      const timer = startFreestyleTimer('yoga', t0)
      expect(timer.kind).toBe('yoga')
      expect(timer.status).toBe('running')
      expect(timer.startTime).toBe(t0)
      expect(timer.intervals).toHaveLength(1)
      expect(timer.intervals[0]).toEqual({ start: t0, end: null })
      expect(getFreestyleTimerElapsedMs(timer, t0 + 5000)).toBe(5000)
    })

    it('pauses and resumes timer without counting paused duration', () => {
      const t0 = 1000000
      let timer = startFreestyleTimer('hiit', t0)

      // Run for 10 seconds
      const t1 = t0 + 10000
      expect(getFreestyleTimerElapsedMs(timer, t1)).toBe(10000)

      // Pause at t1
      timer = pauseFreestyleTimer(timer, t1)
      expect(timer.status).toBe('paused')
      expect(timer.intervals[0].end).toBe(t1)

      // Check elapsed during pause (should stay 10 seconds)
      const t2 = t1 + 30000 // 30s paused
      expect(getFreestyleTimerElapsedMs(timer, t2)).toBe(10000)

      // Resume at t2
      timer = resumeFreestyleTimer(timer, t2)
      expect(timer.status).toBe('running')
      expect(timer.intervals).toHaveLength(2)

      // Run for another 15 seconds (total active = 10s + 15s = 25s)
      const t3 = t2 + 15000
      expect(getFreestyleTimerElapsedMs(timer, t3)).toBe(25000)
    })

    it('finishes timer and creates complete session with sRPE load', () => {
      const t0 = 1000000
      let timer = startFreestyleTimer('mobility', t0)
      const tFinish = t0 + 1200000 // 20 minutes

      const result = finishFreestyleTimer(timer, { rpe: 7, notes: 'Felt limber' }, tFinish)
      expect(result.timerState.status).toBe('finished')
      expect(result.session.kind).toBe('mobility')
      expect(result.session.durationMs).toBe(1200000)
      expect(result.session.rpe).toBe(7)
      expect(result.session.load).toBe(140) // 20 min * 7
      expect(result.session.notes).toBe('Felt limber')
    })
  })

  describe('Store Logging and Retrieval', () => {
    it('logs session into store state (s.freestyleSessions)', () => {
      const payload = {
        kind: 'hiit',
        durationMs: 1500000, // 25 min
        rpe: 8,
        notes: 'Cardio blast'
      }

      const logged = logFreestyleSession(payload, useStore)
      expect(logged.id).toBeDefined()
      expect(logged.kind).toBe('hiit')
      expect(logged.load).toBe(200) // 25 * 8

      const stored = getFreestyleSessions(useStore)
      expect(stored).toHaveLength(1)
      expect(stored[0].id).toBe(logged.id)
      expect(stored[0].kind).toBe('hiit')
      expect(stored[0].load).toBe(200)
    })

    it('throws when logging invalid session', () => {
      expect(() => {
        logFreestyleSession({ kind: 'invalid', durationMs: 1000, rpe: 5 }, useStore)
      }).toThrow(/Invalid freestyle session/)
    })

    it('deletes a freestyle session by id', () => {
      const s1 = logFreestyleSession({ kind: 'yoga', durationMs: 1200000, rpe: 5 }, useStore)
      const s2 = logFreestyleSession({ kind: 'mobility', durationMs: 900000, rpe: 4 }, useStore)

      expect(getFreestyleSessions(useStore)).toHaveLength(2)

      const removed = deleteFreestyleSession(s1.id, useStore)
      expect(removed.id).toBe(s1.id)

      const remaining = getFreestyleSessions(useStore)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe(s2.id)
    })
  })

  describe('FreestyleLoggerSheet Component', () => {
    it('renders initial sheet in idle state with modality selector and timer display', () => {
      const html = renderToStaticMarkup(
        React.createElement(FreestyleLoggerSheet, {
          initialKind: 'yoga',
          store: useStore
        })
      )

      expect(html).toContain('Freestyle Session')
      expect(html).toContain('Yoga')
      expect(html).toContain('HIIT')
      expect(html).toContain('Mobility')
      expect(html).toContain('00:00')
      expect(html).toContain('Start')
      expect(html).toContain('Rate of Perceived Exertion')
    })

    it('renders for hiit and mobility modalities', () => {
      const htmlHiit = renderToStaticMarkup(
        React.createElement(FreestyleLoggerSheet, {
          initialKind: 'hiit',
          store: useStore
        })
      )
      expect(htmlHiit).toContain('Start HIIT')

      const htmlMobility = renderToStaticMarkup(
        React.createElement(FreestyleLoggerSheet, {
          initialKind: 'mobility',
          store: useStore
        })
      )
      expect(htmlMobility).toContain('Start Mobility')
    })

    it('openFreestyleLoggerSheet registers sheet with useUI', () => {
      let openedSheet = null
      const originalOpenSheet = useUI.getState().openSheet
      useUI.getState().openSheet = fn => {
        openedSheet = fn(() => {})
        return 'sheet-id-test'
      }

      try {
        const id = openFreestyleLoggerSheet({ initialKind: 'mobility' })
        expect(id).toBe('sheet-id-test')
        expect(openedSheet).toBeDefined()
        const html = renderToStaticMarkup(openedSheet)
        expect(html).toContain('Freestyle Session')
        expect(html).toContain('Mobility')
      } finally {
        useUI.getState().openSheet = originalOpenSheet
      }
    })
  })
})
