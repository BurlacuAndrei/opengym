import { uid } from './format.js'
import {
  METERS_PER_KM,
  METERS_PER_MILE,
  isImperial,
  distanceUnit,
  paceUnit,
  speedUnit
} from './cardio-format.js'

/**
 * Valid interval step types.
 */
export const STEP_TYPES = ['warmup', 'repeat', 'work', 'recover', 'cooldown']
export const INTERVAL_STEP_TYPES = STEP_TYPES

/**
 * Target types for single steps.
 */
export const TARGET_TYPES = ['duration', 'distance']

/**
 * Standard heart rate zones (1 to 5).
 */
export const HR_ZONES = [1, 2, 3, 4, 5]

/**
 * Creates a single interval step ('warmup', 'work', 'recover', 'cooldown').
 *
 * @param {string} type - Step type ('warmup'|'work'|'recover'|'cooldown')
 * @param {Object} [options] - Step options
 * @returns {Object} Interval step
 */
export function createIntervalStep(type = 'work', options = {}) {
  const safeType = STEP_TYPES.includes(type) && type !== 'repeat' ? type : 'work'
  const id = options.id || ('step-' + uid())

  let durationMs = null
  let distanceM = null

  if (options.durSec != null && !isNaN(Number(options.durSec))) {
    durationMs = Math.max(0, Number(options.durSec) * 1000)
  } else if (options.durationMs != null && !isNaN(Number(options.durationMs))) {
    durationMs = Math.max(0, Number(options.durationMs))
  }
  if (options.distM != null && !isNaN(Number(options.distM))) {
    distanceM = Math.max(0, Number(options.distM))
  } else if (options.distanceM != null && !isNaN(Number(options.distanceM))) {
    distanceM = Math.max(0, Number(options.distanceM))
  }

  // If neither target is explicitly specified, default to 5 min duration for warmup/cooldown, 3 min for work, 1 min for recover
  if (durationMs == null && distanceM == null) {
    if (safeType === 'warmup' || safeType === 'cooldown') {
      durationMs = 300000 // 5 minutes
    } else if (safeType === 'recover') {
      durationMs = 60000 // 1 minute
    } else {
      durationMs = 180000 // 3 minutes
    }
  }

  const targetPace = options.targetPace != null ? options.targetPace : null
  const targetSpeed = options.targetSpeed != null && !isNaN(Number(options.targetSpeed))
    ? Number(options.targetSpeed)
    : (options.targetSpeed != null ? options.targetSpeed : null)
  const targetHrZone = options.targetHrZone != null && !isNaN(Number(options.targetHrZone))
    ? Number(options.targetHrZone)
    : (options.targetHrZone != null ? options.targetHrZone : null)
  const notes = typeof options.notes === 'string' ? options.notes.trim() : ''

  return {
    id,
    type: safeType,
    durationMs,
    distanceM,
    targetPace: targetPace || null,
    targetSpeed,
    targetHrZone,
    notes
  }
}

/**
 * Creates a repeat step block containing a count, workStep, and recoverStep.
 *
 * @param {number} [count=3] - Number of repetitions
 * @param {Object} [workOptions] - Options for the work step
 * @param {Object} [recoverOptions] - Options for the recover step
 * @param {Object} [options] - Additional block options
 * @returns {Object} Repeat step block
 */
export function createRepeatStep(count = 3, workOptions = {}, recoverOptions = {}, options = {}) {
  const safeCount = Math.max(1, Math.floor(Number(count) || 1))
  const id = options.id || ('repeat-' + uid())

  const defaultWorkDur =
    workOptions.durationMs != null || workOptions.durSec != null || workOptions.distanceM != null || workOptions.distM != null
      ? undefined
      : 120000

  const workStep = createIntervalStep('work', {
    durationMs: defaultWorkDur,
    ...workOptions
  })

  const defaultRecurDur =
    recoverOptions.durationMs != null || recoverOptions.durSec != null || recoverOptions.distanceM != null || recoverOptions.distM != null
      ? undefined
      : 60000

  const recoverStep = createIntervalStep('recover', {
    durationMs: defaultRecurDur,
    ...recoverOptions
  })

  const notes = typeof options.notes === 'string' ? options.notes.trim() : ''

  return {
    id,
    type: 'repeat',
    count: safeCount,
    workStep,
    recoverStep,
    notes
  }
}

/**
 * Validates a list of interval steps.
 *
 * @param {Array} steps - Interval steps array
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 */
export function validateIntervalSteps(steps) {
  const errors = []

  if (!Array.isArray(steps)) {
    return { valid: false, errors: ['Steps must be an array'] }
  }

  if (steps.length === 0) {
    return { valid: false, errors: ['Interval workout must have at least one step'] }
  }

  const validateTarget = (step, prefix) => {
    const hasDuration = step.durationMs != null
    const hasDistance = step.distanceM != null

    if (!hasDuration && !hasDistance) {
      errors.push(`${prefix} must have a positive durationMs or distanceM`)
      return
    }

    if (hasDuration) {
      const dur = Number(step.durationMs)
      if (isNaN(dur) || dur <= 0 || !isFinite(dur)) {
        errors.push(`${prefix} durationMs must be a positive number`)
      }
    }

    if (hasDistance) {
      const dist = Number(step.distanceM)
      if (isNaN(dist) || dist <= 0 || !isFinite(dist)) {
        errors.push(`${prefix} distanceM must be a positive number`)
      }
    }

    if (step.targetHrZone != null) {
      const hz = Number(step.targetHrZone)
      if (isNaN(hz) || hz < 1 || hz > 5) {
        errors.push(`${prefix} targetHrZone must be between 1 and 5`)
      }
    }

    if (step.targetSpeed != null) {
      const spd = Number(step.targetSpeed)
      if (isNaN(spd) || spd <= 0 || !isFinite(spd)) {
        errors.push(`${prefix} targetSpeed must be a positive number`)
      }
    }

    if (step.targetPace != null) {
      if (typeof step.targetPace !== 'string' && typeof step.targetPace !== 'number') {
        errors.push(`${prefix} targetPace must be a valid pace string or number`)
      } else if (typeof step.targetPace === 'string' && step.targetPace.trim().length === 0) {
        errors.push(`${prefix} targetPace cannot be an empty string`)
      }
    }
  }

  steps.forEach((step, idx) => {
    const stepLabel = `Step ${idx + 1}`

    if (!step || typeof step !== 'object') {
      errors.push(`${stepLabel} must be a valid step object`)
      return
    }

    if (!STEP_TYPES.includes(step.type)) {
      errors.push(`${stepLabel} has invalid type "${step.type}". Must be one of: ${STEP_TYPES.join(', ')}`)
      return
    }

    if (step.type === 'repeat') {
      const count = Number(step.count)
      if (isNaN(count) || !Number.isInteger(count) || count < 1) {
        errors.push(`${stepLabel} (repeat) must have an integer count of at least 1`)
      }

      if (!step.workStep || typeof step.workStep !== 'object') {
        errors.push(`${stepLabel} (repeat) must have a valid workStep object`)
      } else {
        if (step.workStep.type && step.workStep.type !== 'work') {
          errors.push(`${stepLabel} (repeat) workStep must have type "work"`)
        }
        validateTarget(step.workStep, `${stepLabel} workStep`)
      }

      if (!step.recoverStep || typeof step.recoverStep !== 'object') {
        errors.push(`${stepLabel} (repeat) must have a valid recoverStep object`)
      } else {
        if (step.recoverStep.type && step.recoverStep.type !== 'recover') {
          errors.push(`${stepLabel} (repeat) recoverStep must have type "recover"`)
        }
        validateTarget(step.recoverStep, `${stepLabel} recoverStep`)
      }
    } else {
      validateTarget(step, `${stepLabel} (${step.type})`)
    }
  })

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Calculates total target duration, distance, and step counts for the workout.
 *
 * @param {Array} steps - List of interval steps
 * @returns {{ durationMs: number, distanceM: number, totalDurationMs: number, totalDistanceM: number, stepCount: number, repeatCount: number }}
 */
export function calculateTotalIntervalTarget(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return {
      durationMs: 0,
      distanceM: 0,
      totalDurationMs: 0,
      totalDistanceM: 0,
      stepCount: 0,
      repeatCount: 0
    }
  }

  let totalDurationMs = 0
  let totalDistanceM = 0
  let stepCount = 0
  let repeatCount = 0

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue

    if (step.type === 'repeat') {
      const count = Math.max(1, Math.floor(Number(step.count) || 1))
      repeatCount += count

      const workDur = Number(step.workStep?.durationMs) || 0
      const workDist = Number(step.workStep?.distanceM) || 0
      const recDur = Number(step.recoverStep?.durationMs) || 0
      const recDist = Number(step.recoverStep?.distanceM) || 0

      totalDurationMs += (workDur + recDur) * count
      totalDistanceM += (workDist + recDist) * count

      let repsPerCycle = 0
      if (step.workStep) repsPerCycle++
      if (step.recoverStep) repsPerCycle++
      stepCount += count * repsPerCycle
    } else {
      totalDurationMs += Number(step.durationMs) || 0
      totalDistanceM += Number(step.distanceM) || 0
      stepCount += 1
    }
  }

  return {
    durationMs: totalDurationMs,
    distanceM: totalDistanceM,
    totalDurationMs,
    totalDistanceM,
    stepCount,
    repeatCount
  }
}

/**
 * Cleans an individual single step object into a canonical representation.
 */
function cleanSingleStep(step, defaultType = 'work') {
  if (!step || typeof step !== 'object') return null
  const type = STEP_TYPES.includes(step.type) && step.type !== 'repeat' ? step.type : defaultType
  const durationMs = step.durationMs != null && !isNaN(Number(step.durationMs))
    ? Number(step.durationMs)
    : null
  const distanceM = step.distanceM != null && !isNaN(Number(step.distanceM))
    ? Number(step.distanceM)
    : null
  const targetPace = step.targetPace != null ? String(step.targetPace).trim() : null
  const targetSpeed = step.targetSpeed != null && !isNaN(Number(step.targetSpeed))
    ? Number(step.targetSpeed)
    : null
  const targetHrZone = step.targetHrZone != null && !isNaN(Number(step.targetHrZone))
    ? Number(step.targetHrZone)
    : null
  const notes = typeof step.notes === 'string' ? step.notes.trim() : ''

  return {
    id: step.id || ('step-' + uid()),
    type,
    durationMs,
    distanceM,
    targetPace: targetPace || null,
    targetSpeed,
    targetHrZone,
    notes
  }
}

/**
 * Normalizes and cleans an array of interval steps.
 *
 * @param {Array} steps - Steps array
 * @returns {Array} Cleaned steps array
 */
export function cleanIntervalSteps(steps) {
  if (!Array.isArray(steps)) return []

  return steps.map(step => {
    if (!step || typeof step !== 'object') return null

    if (step.type === 'repeat') {
      const count = Math.max(1, Math.floor(Number(step.count) || 1))
      const workStep = cleanSingleStep(step.workStep, 'work')
      const recoverStep = cleanSingleStep(step.recoverStep, 'recover')
      const notes = typeof step.notes === 'string' ? step.notes.trim() : ''

      return {
        id: step.id || ('repeat-' + uid()),
        type: 'repeat',
        count,
        workStep,
        recoverStep,
        notes
      }
    }

    return cleanSingleStep(step, 'work')
  }).filter(Boolean)
}

/**
 * Serializes interval steps into a clean JSON string or cleaned array.
 *
 * @param {Array} steps - Interval steps array
 * @param {Object} [options] - Serialization options
 * @param {boolean} [options.raw=false] - Return cleaned array instead of JSON string
 * @param {boolean} [options.pretty=false] - Format with indentation if string
 * @returns {string|Array} Serialized interval steps
 */
export function serializeIntervalSteps(steps, options = {}) {
  if (!Array.isArray(steps)) {
    throw new TypeError('serializeIntervalSteps requires an array of steps')
  }

  const cleaned = cleanIntervalSteps(steps)
  if (options.raw) {
    return cleaned
  }

  return options.pretty ? JSON.stringify(cleaned, null, 2) : JSON.stringify(cleaned)
}

/**
 * Deserializes interval steps from a JSON string or cleans an array.
 *
 * @param {string|Array} input - Serialized JSON string or array
 * @returns {Array} Deserialized steps array
 */
export function deserializeIntervalSteps(input) {
  if (!input) return []
  if (Array.isArray(input)) return cleanIntervalSteps(input)
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      return Array.isArray(parsed) ? cleanIntervalSteps(parsed) : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * Reorders a step within the steps list.
 */
export function moveIntervalStep(steps, fromIndex, toIndex) {
  if (!Array.isArray(steps)) return []
  if (fromIndex < 0 || fromIndex >= steps.length) return [...steps]
  if (toIndex < 0 || toIndex >= steps.length) return [...steps]
  if (fromIndex === toIndex) return [...steps]

  const next = [...steps]
  const [removed] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, removed)
  return next
}

/**
 * Duplicates a step in the list, assigning new IDs.
 */
export function duplicateIntervalStep(steps, index) {
  if (!Array.isArray(steps) || index < 0 || index >= steps.length) return [...(steps || [])]
  const target = steps[index]
  if (!target) return [...steps]

  let copy
  if (target.type === 'repeat') {
    copy = {
      ...target,
      id: 'repeat-' + uid(),
      workStep: target.workStep ? { ...target.workStep, id: 'step-' + uid() } : null,
      recoverStep: target.recoverStep ? { ...target.recoverStep, id: 'step-' + uid() } : null
    }
  } else {
    copy = {
      ...target,
      id: 'step-' + uid()
    }
  }

  const next = [...steps]
  next.splice(index + 1, 0, copy)
  return next
}

/**
 * Formats a duration in milliseconds into a concise time string (e.g., "5:00" or "45s").
 */
export function formatStepDuration(durationMs) {
  if (durationMs == null || isNaN(durationMs) || durationMs <= 0) return ''
  const totalSec = Math.round(durationMs / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec}s`
  if (sec === 0) return `${min}m`
  return `${min}:${sec.toString().padStart(2, '0')}`
}

/**
 * Formats a step's target (duration or distance) into a human readable string.
 */
export function formatStepTarget(step, unit = 'km') {
  if (!step) return ''
  const isImp = isImperial(unit)
  const parts = []

  if (step.durationMs != null && step.durationMs > 0) {
    parts.push(formatStepDuration(step.durationMs))
  }

  if (step.distanceM != null && step.distanceM > 0) {
    if (isImp) {
      const miles = step.distanceM / METERS_PER_MILE
      parts.push(miles < 0.2 ? `${Math.round(step.distanceM * 3.28084)} ft` : `${miles.toFixed(2)} mi`)
    } else {
      parts.push(step.distanceM < 1000 ? `${Math.round(step.distanceM)} m` : `${(step.distanceM / 1000).toFixed(2)} km`)
    }
  }

  if (step.targetHrZone != null) {
    parts.push(`Zone ${step.targetHrZone}`)
  }

  if (step.targetPace) {
    parts.push(`@ ${step.targetPace}`)
  } else if (step.targetSpeed != null && step.targetSpeed > 0) {
    parts.push(`@ ${step.targetSpeed} ${speedUnit(unit)}`)
  }

  return parts.join(' · ')
}

/**
 * Flattens interval steps (expanding repeat blocks) into a linear queue of steps.
 *
 * @param {Array} steps - Steps array which may contain repeat blocks
 * @returns {Array} Linear array of flattened steps
 */
export function flattenIntervalSteps(steps) {
  if (!Array.isArray(steps)) return []

  const result = []

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue

    if (step.type === 'repeat') {
      const count = Math.max(1, Math.floor(Number(step.count) || 1))
      const nested = Array.isArray(step.steps)
        ? step.steps
        : [step.workStep, step.recoverStep].filter(Boolean)

      for (let r = 0; r < count; r++) {
        const flattenedSub = flattenIntervalSteps(nested)
        for (const sub of flattenedSub) {
          result.push({
            ...sub,
            repeatIndex: r + 1,
            repeatCount: count,
            repeatId: step.id,
          })
        }
      }
    } else {
      result.push({ ...step })
    }
  }

  return result
}

