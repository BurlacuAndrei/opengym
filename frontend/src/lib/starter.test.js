import { describe, it, expect } from 'vitest'
import { starterRoutines, STARTER_PLANS, createStarterPlan, applyStarterPlan } from './starter.js'
import { EXIDX } from './exercises.js'
import { GLYPHS } from './glyphs.js'
import { ROUTINE_KINDS } from './routine-kind.js'
import { validateCardioPlan } from './cardio-plan.js'
import { effectiveDaySessions } from './history.js'

describe('starterRoutines & STARTER_PLANS (Issue #92)', () => {
  it('preserves starterRoutines() returning [push, pull, legs]', () => {
    const [push, pull, legs] = starterRoutines()
    expect(push.name).toBe('Push Day')
    expect(pull.name).toBe('Pull Day')
    expect(legs.name).toBe('Leg Day')
    expect([push, pull, legs].every(r => r.kind === 'gym')).toBe(true)
  })

  it('defines the 4 expected starter plan templates', () => {
    expect(STARTER_PLANS.map(p => p.id)).toEqual(['hybrid', 'endurance', 'ppl', 'mobility'])
  })

  it.each(['hybrid', 'endurance', 'ppl', 'mobility'])('createStarterPlan(%s) builds valid routines, cardioPlans, and week arrays', (planId) => {
    const planA = createStarterPlan(planId)
    const planB = createStarterPlan(planId)

    expect(planA).toBeTruthy()
    expect(planA.id).toBe(planId)
    expect(planA.routines.length).toBeGreaterThan(0)
    expect(planA.cardioPlans.length).toBeGreaterThan(0)

    // Fresh unique IDs per invocation
    expect(planA.routines[0].id).not.toBe(planB.routines[0].id)

    const routineIds = new Set(planA.routines.map(r => r.id))
    const cardioIds = new Set(planA.cardioPlans.map(c => c.id))

    for (const r of planA.routines) {
      expect(ROUTINE_KINDS).toContain(r.kind)
      expect(GLYPHS).toContain(r.emoji)
      expect(r.ex.length).toBeGreaterThan(0)
      for (const ex of r.ex) {
        expect(EXIDX[ex.id]).toBeTruthy()
      }
    }

    for (const cp of planA.cardioPlans) {
      expect(validateCardioPlan(cp).valid).toBe(true)
    }

    const weekEntries = Object.entries(planA.week)
    expect(weekEntries.length).toBeGreaterThan(0)
    for (const [, ids] of weekEntries) {
      expect(Array.isArray(ids)).toBe(true)
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) {
        expect(routineIds.has(id) || cardioIds.has(id)).toBe(true)
      }
    }
  })

  it('returns null for unknown starter plan id', () => {
    expect(createStarterPlan('nonexistent')).toBeNull()
  })

  it('applyStarterPlan populates state and works with effectiveDaySessions', () => {
    const state = { routines: [], cardioPlans: [], week: {}, dayPlan: {}, workouts: [], cardioActivities: [], freestyleSessions: [] }
    applyStarterPlan(state, 'hybrid')

    expect(state.routines.length).toBeGreaterThanOrEqual(4)
    expect(state.cardioPlans.length).toBeGreaterThanOrEqual(2)
    // Tuesday (2) in hybrid has [tempoRun.id, mobility.id] — 2026-11-17 is a Tuesday
    expect(Array.isArray(state.week[2])).toBe(true)
    expect(state.week[2]).toHaveLength(2)

    const tue = effectiveDaySessions(state, '2026-11-17')
    expect(tue.routines).toHaveLength(1)
    expect(tue.cardioPlans).toHaveLength(1)

    // Unknown id is a safe no-op
    const prevLen = state.routines.length
    expect(applyStarterPlan(state, 'unknown-plan')).toBe(state)
    expect(state.routines).toHaveLength(prevLen)
  })
})
