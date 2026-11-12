import { uid } from './format.js'
import { fmtDist, kmToMeters, milesToMeters, isImperial } from './cardio-format.js'
import { t } from './i18n.js'
import { useStore } from '../store/useStore.js'

export const CARDIO_PLAN_TYPES = ['run', 'ride', 'hike', 'walk']

/**
 * Parses YYYY-MM-DD safely into a local Date object.
 */
export function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null
  const m = dateStr.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const y = parseInt(m[1], 10)
  const mo = parseInt(m[2], 10) - 1
  const d = parseInt(m[3], 10)
  const dt = new Date(y, mo, d)
  return isNaN(dt.getTime()) ? null : dt
}

/**
 * Returns day of week 0..6 (0=Sun, 1=Mon, ..., 6=Sat) for a date string YYYY-MM-DD.
 */
export function getDayOfWeekFromDate(dateStr) {
  const dt = parseDate(dateStr)
  return dt ? dt.getDay() : null
}

/**
 * Extracts ISO date string YYYY-MM-DD from an activity.
 */
export function getActivityDate(activity) {
  if (!activity || typeof activity !== 'object') return null
  if (typeof activity.d === 'string' && activity.d.length >= 10) {
    return activity.d.slice(0, 10)
  }
  if (typeof activity.date === 'string' && activity.date.length >= 10) {
    return activity.date.slice(0, 10)
  }
  if (typeof activity.startTime === 'string' && activity.startTime.length >= 10) {
    return activity.startTime.slice(0, 10)
  }
  return null
}

/**
 * Returns weekday index 0..6 for an activity based on its recorded date.
 */
export function getActivityDayOfWeek(activity) {
  const dateStr = getActivityDate(activity)
  return dateStr ? getDayOfWeekFromDate(dateStr) : null
}

/**
 * Creates and normalizes a planned cardio session target.
 */
export function createCardioPlan(input = {}) {
  const type = CARDIO_PLAN_TYPES.includes(input.type) ? input.type : 'run'
  const targetDistanceM = input.targetDistanceM != null && Number(input.targetDistanceM) > 0
    ? Number(input.targetDistanceM)
    : null
  const targetDurationMs = input.targetDurationMs != null && Number(input.targetDurationMs) > 0
    ? Number(input.targetDurationMs)
    : null
  const notes = typeof input.notes === 'string' ? input.notes.trim() : ''
  const day = input.day != null && input.day !== '' && !isNaN(Number(input.day))
    ? Math.max(0, Math.min(6, Math.floor(Number(input.day))))
    : null
  const date = typeof input.date === 'string' && input.date.length >= 10
    ? input.date.slice(0, 10)
    : null

  return {
    id: input.id || ('cardio-plan-' + uid()),
    type,
    targetDistanceM,
    targetDurationMs,
    notes,
    day,
    date,
    completed: Boolean(input.completed),
    activityId: input.activityId || null,
    completedAt: input.completedAt || null
  }
}

/**
 * Validates a cardio plan target object.
 */
export function validateCardioPlan(plan) {
  const errors = []
  if (!plan || typeof plan !== 'object') {
    return { valid: false, errors: ['Cardio plan must be an object'] }
  }

  if (!plan.type || !CARDIO_PLAN_TYPES.includes(plan.type)) {
    errors.push(`Type must be one of: ${CARDIO_PLAN_TYPES.join(', ')}`)
  }

  if (plan.targetDistanceM != null) {
    const dist = Number(plan.targetDistanceM)
    if (isNaN(dist) || dist < 0 || !isFinite(dist)) {
      errors.push('Target distance must be a positive number')
    }
  }

  if (plan.targetDurationMs != null) {
    const dur = Number(plan.targetDurationMs)
    if (isNaN(dur) || dur < 0 || !isFinite(dur)) {
      errors.push('Target duration must be a positive number')
    }
  }

  if (plan.day != null) {
    const day = Number(plan.day)
    if (isNaN(day) || day < 0 || day > 6 || !Number.isInteger(day)) {
      errors.push('Day must be an integer between 0 and 6')
    }
  }

  if (plan.date != null) {
    if (typeof plan.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(plan.date)) {
      errors.push('Date must be in YYYY-MM-DD format')
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Returns all cardio plans from state.
 */
export function getCardioPlans(state) {
  if (!state || typeof state !== 'object') return []
  if (Array.isArray(state.cardioPlans)) return state.cardioPlans
  if (Array.isArray(state.cardioTargets)) return state.cardioTargets
  return []
}

/**
 * Returns planned cardio sessions for a specific weekday (0..6) or date.
 */
export function getCardioPlansForDay(state, day, dateStr = null) {
  const plans = getCardioPlans(state)
  const weekSessions = Array.isArray(state?.week?.[day])
    ? state.week[day]
    : (typeof state?.week?.[day] === 'string' && state.week[day] ? [state.week[day]] : [])

  return plans.filter(p => {
    if (dateStr && p.date && p.date === dateStr) return true
    if (day != null && p.day === day) return true
    if (day != null && weekSessions.includes(p.id)) return true
    return false
  })
}

/**
 * Checks whether an activity matches a planned cardio session.
 * Requires matching type and same-day scheduling (matching weekday or specific date).
 */
export function matchesCardioPlan(plan, activity) {
  if (!plan || !activity) return false

  const planType = (plan.type || 'run').toLowerCase()
  const actType = (activity.type || activity.sport || 'run').toLowerCase()
  if (planType !== actType) return false

  const actDate = getActivityDate(activity)
  if (!actDate) return false

  const actDay = getActivityDayOfWeek(activity)

  // Specific date matching
  if (plan.date) {
    return plan.date === actDate
  }

  // Weekday schedule matching
  if (plan.day != null) {
    return Number(plan.day) === actDay
  }

  return false
}

/**
 * Finds the best uncompleted matching cardio plan for a given activity.
 */
export function findMatchingCardioPlan(plans, activity) {
  if (!Array.isArray(plans) || !activity) return null

  const candidates = plans.filter(p => !p.completed && !p.activityId && matchesCardioPlan(p, activity))
  if (candidates.length === 0) return null

  // If activity has distance and candidates have target distances, choose closest target
  const actDist = Number(activity.distanceM) || 0
  if (actDist > 0 && candidates.some(c => c.targetDistanceM != null && c.targetDistanceM > 0)) {
    candidates.sort((a, b) => {
      const distA = Math.abs((a.targetDistanceM || 0) - actDist)
      const distB = Math.abs((b.targetDistanceM || 0) - actDist)
      return distA - distB
    })
  }

  return candidates[0]
}

/**
 * Links a cardio plan with a logged activity, marking it completed.
 */
export function linkCardioPlan(plan, activity) {
  if (!plan || !activity) return plan
  return {
    ...plan,
    completed: true,
    activityId: activity.id,
    completedAt: activity.startTime || activity.d || new Date().toISOString()
  }
}

/**
 * Unlinks a cardio plan from its linked activity, marking it uncompleted.
 */
export function unlinkCardioPlan(plan) {
  if (!plan) return plan
  return {
    ...plan,
    completed: false,
    activityId: null,
    completedAt: null
  }
}

/**
 * Automatically reconciles and links same-day logged activities to matching planned cardio sessions.
 * Mutates state in place (consistent with Zustand Immer-like or direct mutation in update(s => ...))
 * and returns the updated array of cardio plans.
 */
export function autoLinkCardioActivities(state) {
  if (!state || typeof state !== 'object') return []
  if (!Array.isArray(state.cardioPlans)) {
    state.cardioPlans = []
  }

  const activities = Array.isArray(state.cardioActivities) ? state.cardioActivities : []
  const activityMap = new Map(activities.map(a => [a.id, a]))
  const usedActivityIds = new Set()

  // First pass: verify existing links
  for (const plan of state.cardioPlans) {
    if (plan.activityId) {
      const act = activityMap.get(plan.activityId)
      if (act && matchesCardioPlan(plan, act)) {
        plan.completed = true
        usedActivityIds.add(plan.activityId)
      } else {
        // Activity deleted or no longer matching -> unlink
        plan.completed = false
        plan.activityId = null
        plan.completedAt = null
      }
    }
  }

  // Second pass: link uncompleted plans to eligible same-day activities
  for (const plan of state.cardioPlans) {
    if (!plan.completed && !plan.activityId) {
      const unlinkedActs = activities.filter(a => !usedActivityIds.has(a.id))
      const matchingPlan = findMatchingCardioPlan([plan], unlinkedActs[0])
      // Find matching activity among unlinked
      const act = unlinkedActs.find(a => matchesCardioPlan(plan, a))
      if (act) {
        plan.completed = true
        plan.activityId = act.id
        plan.completedAt = act.startTime || act.d || new Date().toISOString()
        usedActivityIds.add(act.id)
      }
    }
  }

  return state.cardioPlans
}

/**
 * Adds a new cardio plan target to state and associates it with the weekly schedule.
 */
export function addCardioPlan(state, planInput) {
  if (!state || typeof state !== 'object') return null
  const plan = createCardioPlan(planInput)
  if (!Array.isArray(state.cardioPlans)) {
    state.cardioPlans = []
  }
  state.cardioPlans.push(plan)

  if (plan.day != null) {
    if (!state.week) state.week = {}
    if (Array.isArray(state.week[plan.day])) {
      if (!state.week[plan.day].includes(plan.id)) {
        state.week[plan.day].push(plan.id)
      }
    } else if (typeof state.week[plan.day] === 'string' && state.week[plan.day]) {
      state.week[plan.day] = [state.week[plan.day], plan.id]
    } else {
      state.week[plan.day] = [plan.id]
    }
  }

  autoLinkCardioActivities(state)
  return plan
}

/**
 * Removes a planned cardio session from state and cleans up schedule references.
 */
export function removeCardioPlan(state, planId) {
  if (!state || !Array.isArray(state.cardioPlans)) return false
  const idx = state.cardioPlans.findIndex(p => p.id === planId)
  if (idx === -1) return false

  state.cardioPlans.splice(idx, 1)

  if (state.week && typeof state.week === 'object') {
    for (const d of Object.keys(state.week)) {
      if (Array.isArray(state.week[d])) {
        state.week[d] = state.week[d].filter(id => id !== planId)
        if (state.week[d].length === 0) {
          delete state.week[d]
        }
      } else if (state.week[d] === planId) {
        delete state.week[d]
      }
    }
  }

  return true
}

/**
 * Updates an existing cardio plan in state.
 */
export function updateCardioPlan(state, planId, patch = {}) {
  if (!state || !Array.isArray(state.cardioPlans)) return null
  const plan = state.cardioPlans.find(p => p.id === planId)
  if (!plan) return null

  const oldDay = plan.day
  if (patch.type && CARDIO_PLAN_TYPES.includes(patch.type)) plan.type = patch.type
  if (patch.targetDistanceM !== undefined) {
    plan.targetDistanceM = patch.targetDistanceM != null && Number(patch.targetDistanceM) > 0
      ? Number(patch.targetDistanceM)
      : null
  }
  if (patch.targetDurationMs !== undefined) {
    plan.targetDurationMs = patch.targetDurationMs != null && Number(patch.targetDurationMs) > 0
      ? Number(patch.targetDurationMs)
      : null
  }
  if (patch.notes !== undefined) plan.notes = typeof patch.notes === 'string' ? patch.notes.trim() : ''
  if (patch.day !== undefined) {
    plan.day = patch.day != null && patch.day !== '' ? Number(patch.day) : null
  }
  if (patch.date !== undefined) plan.date = patch.date || null

  // Re-sync weekly schedule if day changed
  if (plan.day !== oldDay) {
    if (oldDay != null && state.week && Array.isArray(state.week[oldDay])) {
      state.week[oldDay] = state.week[oldDay].filter(id => id !== planId)
      if (state.week[oldDay].length === 0) delete state.week[oldDay]
    }
    if (plan.day != null) {
      if (!state.week) state.week = {}
      if (Array.isArray(state.week[plan.day])) {
        if (!state.week[plan.day].includes(plan.id)) state.week[plan.day].push(plan.id)
      } else if (typeof state.week[plan.day] === 'string' && state.week[plan.day]) {
        state.week[plan.day] = [state.week[plan.day], plan.id]
      } else {
        state.week[plan.day] = [plan.id]
      }
    }
  }

  autoLinkCardioActivities(state)
  return plan
}

/**
 * Formats cardio target into a readable display string.
 * e.g. "Run · 5 km · 30 min" or "Ride · 20 km" or "Run"
 */
export function formatCardioTarget(plan, unit = 'kg') {
  if (!plan) return ''
  const typeLabel = t(plan.type ? (plan.type.charAt(0).toUpperCase() + plan.type.slice(1)) : 'Cardio')
  const parts = [typeLabel]

  if (plan.targetDistanceM != null && plan.targetDistanceM > 0) {
    parts.push(fmtDist(plan.targetDistanceM, unit))
  }

  if (plan.targetDurationMs != null && plan.targetDurationMs > 0) {
    const mins = Math.round(plan.targetDurationMs / 60000)
    parts.push(`${mins} min`)
  }

  return parts.join(' · ')
}

/**
 * Store action helpers for useStore integration.
 */
export function addCardioPlanToStore(planInput, store = useStore) {
  let created = null
  store.getState().update(s => {
    created = addCardioPlan(s, planInput)
  })
  return created
}

export function removeCardioPlanFromStore(planId, store = useStore) {
  let removed = false
  store.getState().update(s => {
    removed = removeCardioPlan(s, planId)
  })
  return removed
}

export function updateCardioPlanInStore(planId, patch, store = useStore) {
  let updated = null
  store.getState().update(s => {
    updated = updateCardioPlan(s, planId, patch)
  })
  return updated
}

export function syncCardioPlansInStore(store = useStore) {
  store.getState().update(s => {
    autoLinkCardioActivities(s)
  })
}
