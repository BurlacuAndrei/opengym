import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  STEP_TYPES,
  HR_ZONES,
  createIntervalStep,
  createRepeatStep,
  validateIntervalSteps,
  calculateTotalIntervalTarget,
  cleanIntervalSteps,
  serializeIntervalSteps,
  deserializeIntervalSteps,
  moveIntervalStep,
  duplicateIntervalStep,
  formatStepDuration,
  formatStepTarget
} from './interval-editor.js'
import IntervalEditor from '../components/IntervalEditor.jsx'

describe('Structured Cardio Interval Step Editor (Issue #68)', () => {
  // =========================================================================
  // 1. Step Creation & Factory Defaults
  // =========================================================================
  describe('1. Step Creation & Factory Defaults', () => {
    it('creates a warmup step with default duration of 5 minutes', () => {
      const step = createIntervalStep('warmup')
      expect(step.type).toBe('warmup')
      expect(step.durationMs).toBe(300000)
      expect(step.distanceM).toBeNull()
      expect(step.id).toMatch(/^step-/)
      expect(step.notes).toBe('')
    })

    it('creates a cooldown step with default duration of 5 minutes', () => {
      const step = createIntervalStep('cooldown')
      expect(step.type).toBe('cooldown')
      expect(step.durationMs).toBe(300000)
    })

    it('creates a work step with default duration of 3 minutes', () => {
      const step = createIntervalStep('work')
      expect(step.type).toBe('work')
      expect(step.durationMs).toBe(180000)
    })

    it('creates a recover step with default duration of 1 minute', () => {
      const step = createIntervalStep('recover')
      expect(step.type).toBe('recover')
      expect(step.durationMs).toBe(60000)
    })

    it('supports custom durationMs, distanceM, and targets', () => {
      const step = createIntervalStep('work', {
        durationMs: 120000,
        distanceM: 800,
        targetPace: '4:15/km',
        targetSpeed: 14.1,
        targetHrZone: 4,
        notes: 'Fast 800m repeats'
      })

      expect(step.type).toBe('work')
      expect(step.durationMs).toBe(120000)
      expect(step.distanceM).toBe(800)
      expect(step.targetPace).toBe('4:15/km')
      expect(step.targetSpeed).toBe(14.1)
      expect(step.targetHrZone).toBe(4)
      expect(step.notes).toBe('Fast 800m repeats')
    })

    it('creates a repeat block with default count, workStep, and recoverStep', () => {
      const repeat = createRepeatStep(5)
      expect(repeat.type).toBe('repeat')
      expect(repeat.count).toBe(5)
      expect(repeat.id).toMatch(/^repeat-/)
      expect(repeat.workStep.type).toBe('work')
      expect(repeat.workStep.durationMs).toBe(120000)
      expect(repeat.recoverStep.type).toBe('recover')
      expect(repeat.recoverStep.durationMs).toBe(60000)
    })

    it('creates repeat block with custom nested work and recover options', () => {
      const repeat = createRepeatStep(
        6,
        { distanceM: 400, targetHrZone: 5 },
        { durationMs: 90000, targetHrZone: 2 }
      )

      expect(repeat.count).toBe(6)
      expect(repeat.workStep.distanceM).toBe(400)
      expect(repeat.workStep.targetHrZone).toBe(5)
      expect(repeat.recoverStep.durationMs).toBe(90000)
      expect(repeat.recoverStep.targetHrZone).toBe(2)
    })

    it('handles negative or invalid count in createRepeatStep safely', () => {
      const r1 = createRepeatStep(0)
      expect(r1.count).toBe(1)
      const r2 = createRepeatStep(-5)
      expect(r2.count).toBe(1)
      const r3 = createRepeatStep('invalid')
      expect(r3.count).toBe(1)
    })
  })

  // =========================================================================
  // 2. Validation (validateIntervalSteps)
  // =========================================================================
  describe('2. Validation (validateIntervalSteps)', () => {
    it('validates a correct structured interval plan', () => {
      const steps = [
        createIntervalStep('warmup', { durationMs: 600000 }),
        createRepeatStep(4, { distanceM: 400, targetHrZone: 4 }, { durationMs: 90000, targetHrZone: 2 }),
        createIntervalStep('cooldown', { durationMs: 300000 })
      ]

      const res = validateIntervalSteps(steps)
      expect(res.valid).toBe(true)
      expect(res.errors).toEqual([])
    })

    it('rejects non-array inputs', () => {
      expect(validateIntervalSteps(null).valid).toBe(false)
      expect(validateIntervalSteps(undefined).valid).toBe(false)
      expect(validateIntervalSteps('not-an-array').valid).toBe(false)
      expect(validateIntervalSteps({}).valid).toBe(false)
    })

    it('rejects empty steps array', () => {
      const res = validateIntervalSteps([])
      expect(res.valid).toBe(false)
      expect(res.errors).toContain('Interval workout must have at least one step')
    })

    it('rejects steps with invalid types', () => {
      const steps = [{ id: '1', type: 'sprint', durationMs: 60000 }]
      const res = validateIntervalSteps(steps)
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toContain('invalid type "sprint"')
    })

    it('rejects steps with missing or non-positive targets', () => {
      const steps = [
        { id: '1', type: 'work', durationMs: 0, distanceM: null },
        { id: '2', type: 'work', durationMs: -1000 },
        { id: '3', type: 'work', distanceM: -50 }
      ]
      const res = validateIntervalSteps(steps)
      expect(res.valid).toBe(false)
      expect(res.errors.length).toBeGreaterThan(0)
    })

    it('validates repeat step count and nested steps', () => {
      // Repeat count < 1
      const resCount = validateIntervalSteps([
        {
          id: 'rep-1',
          type: 'repeat',
          count: 0,
          workStep: createIntervalStep('work'),
          recoverStep: createIntervalStep('recover')
        }
      ])
      expect(resCount.valid).toBe(false)
      expect(resCount.errors.some(e => e.includes('integer count'))).toBe(true)

      // Missing workStep
      const resNoWork = validateIntervalSteps([
        {
          id: 'rep-2',
          type: 'repeat',
          count: 3,
          workStep: null,
          recoverStep: createIntervalStep('recover')
        }
      ])
      expect(resNoWork.valid).toBe(false)
      expect(resNoWork.errors.some(e => e.includes('valid workStep'))).toBe(true)

      // Missing recoverStep
      const resNoRec = validateIntervalSteps([
        {
          id: 'rep-3',
          type: 'repeat',
          count: 3,
          workStep: createIntervalStep('work'),
          recoverStep: null
        }
      ])
      expect(resNoRec.valid).toBe(false)
      expect(resNoRec.errors.some(e => e.includes('valid recoverStep'))).toBe(true)
    })

    it('validates optional target constraints (HR zone 1-5, positive speed, pace)', () => {
      const invalidZone = validateIntervalSteps([
        createIntervalStep('work', { durationMs: 60000, targetHrZone: 6 })
      ])
      expect(invalidZone.valid).toBe(false)
      expect(invalidZone.errors.some(e => e.includes('targetHrZone'))).toBe(true)

      const invalidSpeed = validateIntervalSteps([
        createIntervalStep('work', { durationMs: 60000, targetSpeed: -5 })
      ])
      expect(invalidSpeed.valid).toBe(false)
      expect(invalidSpeed.errors.some(e => e.includes('targetSpeed'))).toBe(true)

      const emptyPace = validateIntervalSteps([
        createIntervalStep('work', { durationMs: 60000, targetPace: '   ' })
      ])
      expect(emptyPace.valid).toBe(false)
      expect(emptyPace.errors.some(e => e.includes('targetPace'))).toBe(true)
    })
  })

  // =========================================================================
  // 3. Target Calculations (calculateTotalIntervalTarget)
  // =========================================================================
  describe('3. Target Calculations (calculateTotalIntervalTarget)', () => {
    it('returns zeroes for empty or null steps', () => {
      const res = calculateTotalIntervalTarget([])
      expect(res.durationMs).toBe(0)
      expect(res.distanceM).toBe(0)
      expect(res.stepCount).toBe(0)
      expect(res.repeatCount).toBe(0)

      expect(calculateTotalIntervalTarget(null).durationMs).toBe(0)
    })

    it('sums single steps without repeat blocks', () => {
      const steps = [
        createIntervalStep('warmup', { durationMs: 300000 }), // 5 min
        createIntervalStep('work', { durationMs: 180000, distanceM: 800 }), // 3 min, 800m
        createIntervalStep('cooldown', { durationMs: 300000, distanceM: 500 }) // 5 min, 500m
      ]

      const totals = calculateTotalIntervalTarget(steps)
      expect(totals.durationMs).toBe(780000) // 13 min
      expect(totals.totalDurationMs).toBe(780000)
      expect(totals.distanceM).toBe(1300)
      expect(totals.totalDistanceM).toBe(1300)
      expect(totals.stepCount).toBe(3)
      expect(totals.repeatCount).toBe(0)
    })

    it('correctly multiplies repeat blocks by repeat count', () => {
      const steps = [
        createIntervalStep('warmup', { durationMs: 300000 }), // 5 min
        createRepeatStep(
          5, // 5 x
          { durationMs: 120000, distanceM: 400 }, // 2 min, 400m work
          { durationMs: 60000 } // 1 min recover
        ),
        createIntervalStep('cooldown', { durationMs: 300000 }) // 5 min
      ]

      const totals = calculateTotalIntervalTarget(steps)
      // Duration: 300s + 5 * (120s + 60s) + 300s = 300 + 900 + 300 = 1500s = 1,500,000 ms
      expect(totals.durationMs).toBe(1500000)
      // Distance: 5 * 400m = 2000m
      expect(totals.distanceM).toBe(2000)
      // Step count: 1 (warmup) + 5 * 2 (work+recover) + 1 (cooldown) = 12 steps
      expect(totals.stepCount).toBe(12)
      expect(totals.repeatCount).toBe(5)
    })
  })

  // =========================================================================
  // 4. Serialization & Deserialization
  // =========================================================================
  describe('4. Serialization & Deserialization', () => {
    it('serializes steps to a JSON string and deserializes back', () => {
      const steps = [
        createIntervalStep('warmup', { durationMs: 300000 }),
        createRepeatStep(4, { distanceM: 500 }, { durationMs: 60000 }),
        createIntervalStep('cooldown', { durationMs: 300000 })
      ]

      const jsonStr = serializeIntervalSteps(steps)
      expect(typeof jsonStr).toBe('string')

      const deserialized = deserializeIntervalSteps(jsonStr)
      expect(deserialized.length).toBe(3)
      expect(deserialized[0].type).toBe('warmup')
      expect(deserialized[1].type).toBe('repeat')
      expect(deserialized[1].count).toBe(4)
      expect(deserialized[1].workStep.distanceM).toBe(500)
      expect(deserialized[2].type).toBe('cooldown')
    })

    it('supports raw: true option to return cleaned array directly', () => {
      const steps = [createIntervalStep('work', { durationMs: 120000 })]
      const raw = serializeIntervalSteps(steps, { raw: true })
      expect(Array.isArray(raw)).toBe(true)
      expect(raw[0].type).toBe('work')
      expect(raw[0].durationMs).toBe(120000)
    })

    it('supports pretty formatting in serializeIntervalSteps', () => {
      const steps = [createIntervalStep('work', { durationMs: 60000 })]
      const formatted = serializeIntervalSteps(steps, { pretty: true })
      expect(formatted).toContain('\n')
      expect(formatted).toContain('  "type": "work"')
    })

    it('handles invalid or empty inputs in deserializeIntervalSteps', () => {
      expect(deserializeIntervalSteps(null)).toEqual([])
      expect(deserializeIntervalSteps('')).toEqual([])
      expect(deserializeIntervalSteps('{ invalid json }')).toEqual([])
      expect(deserializeIntervalSteps([])).toEqual([])
    })

    it('throws TypeError if serializeIntervalSteps is given non-array', () => {
      expect(() => serializeIntervalSteps(null)).toThrow(TypeError)
      expect(() => serializeIntervalSteps('test')).toThrow(TypeError)
    })
  })

  // =========================================================================
  // 5. Step Reordering & Mutation Helpers
  // =========================================================================
  describe('5. Step Reordering & Mutation Helpers', () => {
    it('moves steps up and down correctly', () => {
      const stepA = createIntervalStep('warmup', { id: 'A' })
      const stepB = createIntervalStep('work', { id: 'B' })
      const stepC = createIntervalStep('cooldown', { id: 'C' })
      const steps = [stepA, stepB, stepC]

      // Move B to top (index 1 -> 0)
      const reordered = moveIntervalStep(steps, 1, 0)
      expect(reordered.map(s => s.id)).toEqual(['B', 'A', 'C'])

      // Move A to bottom (index 0 -> 2)
      const bottom = moveIntervalStep(steps, 0, 2)
      expect(bottom.map(s => s.id)).toEqual(['B', 'C', 'A'])

      // Out of bounds preserves array
      expect(moveIntervalStep(steps, -1, 2)).toEqual(steps)
      expect(moveIntervalStep(steps, 0, 5)).toEqual(steps)
    })

    it('duplicates single steps with unique IDs', () => {
      const original = [
        createIntervalStep('work', { id: 'step-orig', durationMs: 120000 })
      ]
      const duplicated = duplicateIntervalStep(original, 0)
      expect(duplicated.length).toBe(2)
      expect(duplicated[0].id).toBe('step-orig')
      expect(duplicated[1].id).not.toBe('step-orig')
      expect(duplicated[1].durationMs).toBe(120000)
    })

    it('duplicates repeat steps and their nested steps with unique IDs', () => {
      const repeat = createRepeatStep(3)
      const list = [repeat]
      const duplicated = duplicateIntervalStep(list, 0)

      expect(duplicated.length).toBe(2)
      expect(duplicated[1].id).not.toBe(repeat.id)
      expect(duplicated[1].workStep.id).not.toBe(repeat.workStep.id)
      expect(duplicated[1].recoverStep.id).not.toBe(repeat.recoverStep.id)
    })

    it('formats step duration correctly', () => {
      expect(formatStepDuration(30000)).toBe('30s')
      expect(formatStepDuration(180000)).toBe('3m')
      expect(formatStepDuration(150000)).toBe('2:30')
      expect(formatStepDuration(0)).toBe('')
      expect(formatStepDuration(null)).toBe('')
    })

    it('formats step target description with HR zone and pace', () => {
      const step = createIntervalStep('work', {
        durationMs: 120000,
        distanceM: 400,
        targetHrZone: 4,
        targetPace: '4:30'
      })

      const desc = formatStepTarget(step, 'km')
      expect(desc).toContain('2m')
      expect(desc).toContain('400 m')
      expect(desc).toContain('Zone 4')
      expect(desc).toContain('@ 4:30')
    })
  })

  // =========================================================================
  // 6. UI Component Rendering (IntervalEditor)
  // =========================================================================
  describe('6. UI Component Rendering (IntervalEditor)', () => {
    it('renders empty state when no steps are passed', () => {
      const html = renderToStaticMarkup(
        React.createElement(IntervalEditor, {
          steps: [],
          onChange: () => {}
        })
      )

      expect(html).toContain('data-testid="interval-editor"')
      expect(html).toContain('data-testid="interval-empty-state"')
      expect(html).toContain('No interval steps configured yet')
      expect(html).toContain('data-testid="interval-add-controls"')
      expect(html).toContain('Warmup')
      expect(html).toContain('Repeat Block')
      expect(html).toContain('Cooldown')
    })

    it('renders step list with warmup, repeat block, and cooldown steps', () => {
      const steps = [
        createIntervalStep('warmup', { durationMs: 300000 }),
        createRepeatStep(4, { distanceM: 400 }, { durationMs: 60000 }),
        createIntervalStep('cooldown', { durationMs: 300000 })
      ]

      const html = renderToStaticMarkup(
        React.createElement(IntervalEditor, {
          steps,
          unit: 'km',
          onChange: () => {}
        })
      )

      expect(html).toContain('data-testid="interval-step-0"')
      expect(html).toContain('data-testid="interval-step-1"')
      expect(html).toContain('data-testid="interval-step-2"')
      expect(html).toContain('Warmup')
      expect(html).toContain('Repeat Block')
      expect(html).toContain('Cooldown')

      // Nested repeat block elements
      expect(html).toContain('data-testid="repeat-block-1"')
      expect(html).toContain('data-testid="repeat-work-step-1"')
      expect(html).toContain('data-testid="repeat-recover-step-1"')
      expect(html).toContain('Work Interval')
      expect(html).toContain('Recover Interval')
      expect(html).toContain('Repeat Count:')
    })

    it('renders totals header bar with duration and step count', () => {
      const steps = [
        createIntervalStep('warmup', { durationMs: 300000 }),
        createRepeatStep(3, { durationMs: 120000 }, { durationMs: 60000 })
      ]

      const html = renderToStaticMarkup(
        React.createElement(IntervalEditor, {
          steps,
          onChange: () => {}
        })
      )

      expect(html).toContain('data-testid="interval-summary-bar"')
      expect(html).toContain('Duration:')
      expect(html).toContain('Steps:')
      // 1 warmup + 3 * 2 = 7 steps
      expect(html).toContain('7')
    })

    it('renders readOnly mode without mutating controls or add buttons', () => {
      const steps = [createIntervalStep('work', { durationMs: 180000 })]

      const html = renderToStaticMarkup(
        React.createElement(IntervalEditor, {
          steps,
          readOnly: true,
          onChange: () => {}
        })
      )

      expect(html).toContain('data-testid="interval-editor"')
      expect(html).not.toContain('data-testid="interval-add-controls"')
      expect(html).not.toContain('aria-label="Remove step"')
      expect(html).not.toContain('aria-label="Duplicate step"')
      expect(html).toContain('disabled=""')
    })

    it('displays validation warning when invalid steps are supplied', () => {
      const invalidSteps = [
        { id: '1', type: 'work', durationMs: -500 }
      ]

      const html = renderToStaticMarkup(
        React.createElement(IntervalEditor, {
          steps: invalidSteps,
          onChange: () => {}
        })
      )

      expect(html).toContain('data-testid="interval-validation-warning"')
      expect(html).toContain('durationMs must be a positive number')
    })
  })
})
