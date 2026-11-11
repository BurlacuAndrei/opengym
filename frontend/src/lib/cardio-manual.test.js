import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  useStore,
  DEF,
  hasData,
  CARDIO_TYPES,
  validateCardioActivity,
  normalizeCardioActivity,
  logCardioActivity,
  updateCardioActivity,
  deleteCardioActivity
} from '../store/useStore.js'
import ManualCardioSheet from '../components/ManualCardioSheet.jsx'
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

describe('Manual Cardio Activity Logging (Issue #45)', () => {
  beforeEach(() => {
    localStorage.clear()
    useStore.setState({
      S: JSON.parse(JSON.stringify(DEF)),
      user: null
    })
  })

  describe('Default State & hasData integration', () => {
    it('initializes cardioActivities as empty array in DEF and state', () => {
      expect(DEF.cardioActivities).toEqual([])
      expect(useStore.getState().S.cardioActivities).toEqual([])
    })

    it('hasData recognizes cardioActivities count', () => {
      const emptyState = { workouts: [], routines: [], bodyweight: [], cardioActivities: [] }
      expect(hasData(emptyState)).toBe(false)

      const withCardio = { ...emptyState, cardioActivities: [{ id: 'c1', type: 'run' }] }
      expect(hasData(withCardio)).toBe(true)
    })
  })

  describe('validateCardioActivity', () => {
    it('validates correct activity payload', () => {
      const validPayload = {
        type: 'run',
        durationMs: 1800000, // 30 min
        distanceM: 5000,
        elevationGainM: 50,
        rpe: 7,
        calories: 320,
        startTime: '2026-11-11T10:00:00Z',
        gearId: 'Pegasus 40',
        notes: 'Great tempo run'
      }
      const res = validateCardioActivity(validPayload)
      expect(res.valid).toBe(true)
      expect(res.errors).toEqual([])
    })

    it('rejects invalid or non-object payloads', () => {
      expect(validateCardioActivity(null).valid).toBe(false)
      expect(validateCardioActivity('not-an-object').valid).toBe(false)
    })

    it('rejects unknown activity type', () => {
      const res = validateCardioActivity({ type: 'swimming', durationMs: 1000 })
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toContain('Type must be one of')
    })

    it('accepts all allowed types: run, ride, hike, walk', () => {
      for (const t of CARDIO_TYPES) {
        const res = validateCardioActivity({ type: t, durationMs: 60000 })
        expect(res.valid).toBe(true)
      }
    })

    it('requires durationMs to be greater than 0', () => {
      expect(validateCardioActivity({ type: 'run', durationMs: 0 }).valid).toBe(false)
      expect(validateCardioActivity({ type: 'run', durationMs: -500 }).valid).toBe(false)
      expect(validateCardioActivity({ type: 'run', durationMs: NaN }).valid).toBe(false)
      expect(validateCardioActivity({ type: 'run' }).valid).toBe(false)
    })

    it('validates distanceM, elevationGainM, calories are non-negative', () => {
      expect(validateCardioActivity({ type: 'run', durationMs: 1000, distanceM: -10 }).valid).toBe(false)
      expect(validateCardioActivity({ type: 'run', durationMs: 1000, elevationGainM: -5 }).valid).toBe(false)
      expect(validateCardioActivity({ type: 'run', durationMs: 1000, calories: -100 }).valid).toBe(false)
    })

    it('validates RPE is between 1 and 10', () => {
      expect(validateCardioActivity({ type: 'run', durationMs: 1000, rpe: 0 }).valid).toBe(false)
      expect(validateCardioActivity({ type: 'run', durationMs: 1000, rpe: 11 }).valid).toBe(false)
      expect(validateCardioActivity({ type: 'run', durationMs: 1000, rpe: 1 }).valid).toBe(true)
      expect(validateCardioActivity({ type: 'run', durationMs: 1000, rpe: 10 }).valid).toBe(true)
    })

    it('validates startTime date format', () => {
      expect(validateCardioActivity({ type: 'run', durationMs: 1000, startTime: 'invalid-date' }).valid).toBe(false)
      expect(validateCardioActivity({ type: 'run', durationMs: 1000, startTime: '2026-11-11T08:30:00Z' }).valid).toBe(true)
    })
  })

  describe('normalizeCardioActivity', () => {
    it('auto-computes pace (sec/km) and speed (km/h) for duration and distance', () => {
      // 5 km in 25 min (1,500,000 ms) => pace: 300 s/km (5:00 min/km), speed: 12 km/h
      const norm = normalizeCardioActivity({
        type: 'run',
        durationMs: 1500000,
        distanceM: 5000
      })
      expect(norm.id).toBeDefined()
      expect(norm.avgPaceSecKm).toBeCloseTo(300, 1)
      expect(norm.avgSpeedKmh).toBeCloseTo(12, 1)
      expect(norm.elevationGainM).toBe(0)
    })

    it('handles stationary / zero-distance activities without pace/speed errors', () => {
      const norm = normalizeCardioActivity({
        type: 'ride',
        durationMs: 1200000,
        distanceM: 0
      })
      expect(norm.avgPaceSecKm).toBeNull()
      expect(norm.avgSpeedKmh).toBeNull()
    })

    it('preserves explicitly provided pace and speed', () => {
      const norm = normalizeCardioActivity({
        type: 'run',
        durationMs: 1500000,
        distanceM: 5000,
        avgPaceSecKm: 290,
        avgSpeedKmh: 12.4
      })
      expect(norm.avgPaceSecKm).toBe(290)
      expect(norm.avgSpeedKmh).toBe(12.4)
    })
  })

  describe('Store Methods: log, update, delete', () => {
    it('logCardioActivity adds activity and returns normalized record', () => {
      const act = logCardioActivity({
        type: 'run',
        durationMs: 1200000,
        distanceM: 4000,
        elevationGainM: 30,
        rpe: 8,
        notes: 'Morning run'
      })

      expect(act.id).toBeDefined()
      expect(act.type).toBe('run')
      expect(act.durationMs).toBe(1200000)
      expect(act.distanceM).toBe(4000)
      expect(act.avgPaceSecKm).toBeCloseTo(300, 1)
      expect(act.avgSpeedKmh).toBeCloseTo(12, 1)

      const storeActivities = useStore.getState().S.cardioActivities
      expect(storeActivities).toHaveLength(1)
      expect(storeActivities[0].id).toBe(act.id)
    })

    it('updateCardioActivity modifies existing record and recalculates metrics', () => {
      const initial = logCardioActivity({
        id: 'c-test-1',
        type: 'run',
        durationMs: 1500000, // 25 min
        distanceM: 5000     // 5 km -> 12 km/h
      })

      expect(initial.avgSpeedKmh).toBeCloseTo(12, 1)

      // Update distance to 6000m (same 25 min -> 14.4 km/h)
      const updated = updateCardioActivity('c-test-1', {
        distanceM: 6000,
        notes: 'Faster than expected'
      })

      expect(updated).toBeDefined()
      expect(updated.distanceM).toBe(6000)
      expect(updated.notes).toBe('Faster than expected')
      expect(updated.avgSpeedKmh).toBeCloseTo(14.4, 1)
      expect(updated.avgPaceSecKm).toBeCloseTo(250, 1) // 1500s / 6km = 250s/km

      const inStore = useStore.getState().S.cardioActivities.find(x => x.id === 'c-test-1')
      expect(inStore.distanceM).toBe(6000)
    })

    it('updateCardioActivity returns null when id does not exist', () => {
      const res = updateCardioActivity('non-existent', { distanceM: 5000 })
      expect(res).toBeNull()
    })

    it('deleteCardioActivity removes record and returns removed entry', () => {
      logCardioActivity({ id: 'c-1', type: 'run', durationMs: 60000 })
      logCardioActivity({ id: 'c-2', type: 'ride', durationMs: 120000 })

      expect(useStore.getState().S.cardioActivities).toHaveLength(2)

      const removed = deleteCardioActivity('c-1')
      expect(removed.id).toBe('c-1')

      const remaining = useStore.getState().S.cardioActivities
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('c-2')

      const notFound = deleteCardioActivity('c-missing')
      expect(notFound).toBeNull()
    })
  })

  describe('ManualCardioSheet Component', () => {
    it('renders in create mode with default fields', () => {
      const html = renderToStaticMarkup(
        React.createElement(ManualCardioSheet, {
          close: () => {}
        })
      )

      expect(html).toContain('Log cardio')
      expect(html).toContain('Run')
      expect(html).toContain('Ride')
      expect(html).toContain('Hike')
      expect(html).toContain('Walk')
      expect(html).toContain('Duration (min)')
      expect(html).toContain('Distance (km)')
      expect(html).toContain('Elevation Gain (m)')
      expect(html).toContain('Perceived Exertion (RPE 1–10)')
      expect(html).toContain('Save activity')
      // In create mode, delete button should not be present
      expect(html).not.toContain('trash')
    })

    it('renders in edit mode with prefilled values and delete button', () => {
      const existingActivity = {
        id: 'act-edit-1',
        type: 'ride',
        startTime: '2026-11-11T14:00:00.000Z',
        durationMs: 3600000, // 60 min
        distanceM: 20000,   // 20 km
        elevationGainM: 150,
        calories: 500,
        rpe: 6,
        gearId: 'Canyon Endurace',
        notes: 'Windy afternoon'
      }

      const html = renderToStaticMarkup(
        React.createElement(ManualCardioSheet, {
          activity: existingActivity,
          close: () => {}
        })
      )

      expect(html).toContain('Edit cardio')
      expect(html).toContain('Update activity')
      expect(html).toContain('aria-label="Delete"')
      expect(html).toContain('value="60"') // 60 min duration
      expect(html).toContain('value="20"') // 20 km distance
      expect(html).toContain('value="150"') // 150 m elevation
      expect(html).toContain('value="500"') // 500 cal
      expect(html).toContain('Canyon Endurace')
      expect(html).toContain('Windy afternoon')
      expect(html).toContain('Avg Speed')
      expect(html).toContain('20 km/h')
    })

    it('respects imperial unit mode (miles & feet)', () => {
      useStore.getState().update(s => {
        s.unit = 'lbs'
      }, false)

      const html = renderToStaticMarkup(
        React.createElement(ManualCardioSheet, {
          close: () => {}
        })
      )

      expect(html).toContain('Distance (mi)')
      expect(html).toContain('Elevation Gain (ft)')
    })

    it('openManualCardioSheet helper registers sheet with useUI', async () => {
      const openSheetSpy = vi.fn()
      useUI.setState({ openSheet: openSheetSpy })

      const { openManualCardioSheet } = await import('../components/ManualCardioSheet.jsx')
      openManualCardioSheet({ id: 'test-act' })

      expect(openSheetSpy).toHaveBeenCalledTimes(1)
      expect(typeof openSheetSpy.mock.calls[0][0]).toBe('function')
    })
  })
})
