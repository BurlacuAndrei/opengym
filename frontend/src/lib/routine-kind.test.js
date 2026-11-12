import { describe, it, expect } from 'vitest'
import {
  ROUTINE_KINDS,
  DEFAULT_ROUTINE_KIND,
  ROUTINE_KIND_LABELS,
  ROUTINE_KIND_ICONS,
  isRoutineKind,
  getRoutineKind,
  getRoutineRestSec,
  normalizeRoutine
} from './routine-kind.js'

describe('routine-kind (Issue #59)', () => {
  describe('constants & isRoutineKind', () => {
    it('defines the 4 supported routine kinds and default', () => {
      expect(ROUTINE_KINDS).toEqual(['gym', 'hiit', 'yoga', 'mobility'])
      expect(DEFAULT_ROUTINE_KIND).toBe('gym')
    })

    it('has labels and icons for all supported kinds', () => {
      for (const kind of ROUTINE_KINDS) {
        expect(ROUTINE_KIND_LABELS[kind]).toBeDefined()
        expect(ROUTINE_KIND_ICONS[kind]).toBeDefined()
      }
    })

    it('validates routine kinds correctly', () => {
      expect(isRoutineKind('gym')).toBe(true)
      expect(isRoutineKind('hiit')).toBe(true)
      expect(isRoutineKind('yoga')).toBe(true)
      expect(isRoutineKind('mobility')).toBe(true)
      expect(isRoutineKind('pilates')).toBe(false)
      expect(isRoutineKind('')).toBe(false)
      expect(isRoutineKind(null)).toBe(false)
      expect(isRoutineKind(undefined)).toBe(false)
      expect(isRoutineKind(123)).toBe(false)
    })
  })

  describe('getRoutineKind', () => {
    it('returns routine kind when explicitly set', () => {
      expect(getRoutineKind({ id: 'r1', kind: 'gym' })).toBe('gym')
      expect(getRoutineKind({ id: 'r2', kind: 'hiit' })).toBe('hiit')
      expect(getRoutineKind({ id: 'r3', kind: 'yoga' })).toBe('yoga')
      expect(getRoutineKind({ id: 'r4', kind: 'mobility' })).toBe('mobility')
    })

    it('defaults to gym for legacy routines without kind field', () => {
      expect(getRoutineKind({ id: 'r-legacy', name: 'Leg Day', ex: [] })).toBe('gym')
      expect(getRoutineKind({})).toBe('gym')
    })

    it('defaults to gym for invalid kind values', () => {
      expect(getRoutineKind({ kind: 'crossfit' })).toBe('gym')
      expect(getRoutineKind({ kind: '' })).toBe('gym')
      expect(getRoutineKind({ kind: null })).toBe('gym')
      expect(getRoutineKind({ kind: 42 })).toBe('gym')
    })

    it('defaults to gym when passed null or undefined', () => {
      expect(getRoutineKind(null)).toBe('gym')
      expect(getRoutineKind(undefined)).toBe('gym')
    })

    it('supports direct kind string input', () => {
      expect(getRoutineKind('hiit')).toBe('hiit')
      expect(getRoutineKind('yoga')).toBe('yoga')
      expect(getRoutineKind('invalid')).toBe('gym')
    })
  })

  describe('getRoutineRestSec', () => {
    it('uses routine restSec override when set', () => {
      expect(getRoutineRestSec({ restSec: 45 }, 90)).toBe(45)
      expect(getRoutineRestSec({ restSec: 120 }, 60)).toBe(120)
      expect(getRoutineRestSec({ restSec: 0 }, 90)).toBe(0)
      expect(getRoutineRestSec({ restSec: '30' }, 90)).toBe(30)
    })

    it('falls back to global setting when routine has no override', () => {
      expect(getRoutineRestSec({ name: 'Push' }, 90)).toBe(90)
      expect(getRoutineRestSec({ restSec: null }, 60)).toBe(60)
      expect(getRoutineRestSec({ restSec: undefined }, 120)).toBe(120)
      expect(getRoutineRestSec({ restSec: '' }, 75)).toBe(75)
    })

    it('falls back to global setting when routine object is null or undefined', () => {
      expect(getRoutineRestSec(null, 90)).toBe(90)
      expect(getRoutineRestSec(undefined, 60)).toBe(60)
    })

    it('falls back to default 90s when neither override nor global setting provided', () => {
      expect(getRoutineRestSec(null)).toBe(90)
      expect(getRoutineRestSec({}, null)).toBe(90)
      expect(getRoutineRestSec({}, undefined)).toBe(90)
    })

    it('ignores invalid restSec values on routine and falls back', () => {
      expect(getRoutineRestSec({ restSec: -10 }, 90)).toBe(90)
      expect(getRoutineRestSec({ restSec: 'not-a-number' }, 90)).toBe(90)
      expect(getRoutineRestSec({ restSec: NaN }, 90)).toBe(90)
    })
  })

  describe('normalizeRoutine', () => {
    it('ensures kind is present and valid, defaulting to gym', () => {
      const legacy = { id: 'r1', name: 'Push', ex: [] }
      expect(normalizeRoutine(legacy)).toEqual({ id: 'r1', name: 'Push', ex: [], kind: 'gym' })

      const invalid = { id: 'r2', kind: 'aerobic' }
      expect(normalizeRoutine(invalid)).toEqual({ id: 'r2', kind: 'gym' })

      const valid = { id: 'r3', kind: 'hiit' }
      expect(normalizeRoutine(valid)).toEqual({ id: 'r3', kind: 'hiit' })
    })

    it('preserves valid restSec override and cleans up invalid restSec', () => {
      const withRest = { id: 'r1', kind: 'mobility', restSec: 45 }
      expect(normalizeRoutine(withRest)).toEqual({ id: 'r1', kind: 'mobility', restSec: 45 })

      const withBadRest = { id: 'r2', kind: 'yoga', restSec: -5 }
      expect(normalizeRoutine(withBadRest)).toEqual({ id: 'r2', kind: 'yoga' })

      const withEmptyRest = { id: 'r3', restSec: '' }
      expect(normalizeRoutine(withEmptyRest)).toEqual({ id: 'r3', kind: 'gym' })
    })

    it('handles non-object inputs gracefully', () => {
      expect(normalizeRoutine(null)).toBe(null)
      expect(normalizeRoutine(undefined)).toBe(undefined)
    })
  })
})
