/**
 * Routine kind support and helpers (Issue #59).
 * Kinds: 'gym' | 'hiit' | 'yoga' | 'mobility'
 */

export const ROUTINE_KINDS = ['gym', 'hiit', 'yoga', 'mobility']
export const DEFAULT_ROUTINE_KIND = 'gym'

export const ROUTINE_KIND_LABELS = {
  gym: 'Gym',
  hiit: 'HIIT',
  yoga: 'Yoga',
  mobility: 'Mobility'
}

export const ROUTINE_KIND_ICONS = {
  gym: 'dumbbell',
  hiit: 'flame',
  yoga: 'sparkles',
  mobility: 'stretch'
}

export function isRoutineKind(kind) {
  return typeof kind === 'string' && ROUTINE_KINDS.includes(kind)
}

/**
 * Returns the kind of routine ('gym' | 'hiit' | 'yoga' | 'mobility').
 * Defaults to 'gym' for legacy routines or invalid inputs.
 */
export function getRoutineKind(routineOrKind) {
  if (!routineOrKind) return DEFAULT_ROUTINE_KIND
  if (typeof routineOrKind === 'string') {
    return isRoutineKind(routineOrKind) ? routineOrKind : DEFAULT_ROUTINE_KIND
  }
  if (typeof routineOrKind === 'object') {
    return isRoutineKind(routineOrKind.kind) ? routineOrKind.kind : DEFAULT_ROUTINE_KIND
  }
  return DEFAULT_ROUTINE_KIND
}

/**
 * Resolves the effective rest timer in seconds for a routine.
 * If routine has a restSec override (number >= 0), it is used;
 * otherwise it falls back to the global restSec setting (defaults to 90).
 */
export function getRoutineRestSec(routine, globalRestSec = 90) {
  const fallback = (globalRestSec != null && Number.isFinite(Number(globalRestSec)))
    ? Number(globalRestSec)
    : 90

  if (!routine || typeof routine !== 'object') {
    return fallback
  }

  if (routine.restSec != null && routine.restSec !== '') {
    const val = Number(routine.restSec)
    if (Number.isFinite(val) && val >= 0) {
      return val
    }
  }

  return fallback
}

/**
 * Normalizes a routine object to ensure schema compliance:
 * - kind is set to a valid kind (defaults to 'gym')
 * - restSec is kept only if valid non-negative number
 */
export function normalizeRoutine(routine) {
  if (!routine || typeof routine !== 'object') return routine
  const res = {
    ...routine,
    kind: getRoutineKind(routine)
  }
  if (routine.restSec != null && routine.restSec !== '') {
    const val = Number(routine.restSec)
    if (Number.isFinite(val) && val >= 0) {
      res.restSec = val
    } else {
      delete res.restSec
    }
  } else if ('restSec' in routine) {
    delete res.restSec
  }
  return res
}
