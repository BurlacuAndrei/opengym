import { calculateSessionLoad } from './training-load.js'
import { uid } from './format.js'
import { useStore } from '../store/useStore.js'

/**
 * Supported freestyle modalities (Issue #70).
 */
export const FREESTYLE_MODALITIES = Object.freeze(['hiit', 'yoga', 'mobility'])

/**
 * Checks if a modality string is valid.
 * @param {string} kind
 * @returns {boolean}
 */
export function isValidModality(kind) {
  return typeof kind === 'string' && FREESTYLE_MODALITIES.includes(kind.trim().toLowerCase())
}

/**
 * Capitalizes or formats modality kind for display.
 * @param {string} kind
 * @returns {string}
 */
export function formatModality(kind) {
  if (!kind) return ''
  const k = String(kind).trim().toLowerCase()
  if (k === 'hiit') return 'HIIT'
  if (k === 'yoga') return 'Yoga'
  if (k === 'mobility') return 'Mobility'
  return k.charAt(0).toUpperCase() + k.slice(1)
}

/**
 * Validates a freestyle session payload.
 * @param {Object} session
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateFreestyleSession(session) {
  const errors = []
  if (!session || typeof session !== 'object') {
    return { valid: false, errors: ['Session must be a valid object'] }
  }

  const kind = session.kind ? String(session.kind).trim().toLowerCase() : ''
  if (!isValidModality(kind)) {
    errors.push(`Modality kind must be one of: ${FREESTYLE_MODALITIES.join(', ')}`)
  }

  const durationMs = Number(session.durationMs)
  if (isNaN(durationMs) || durationMs <= 0 || !isFinite(durationMs)) {
    errors.push('durationMs must be a positive number')
  }

  const rpe = Number(session.rpe)
  if (isNaN(rpe) || rpe < 1 || rpe > 10 || !isFinite(rpe)) {
    errors.push('rpe must be a number between 1 and 10')
  }

  if (session.notes != null && typeof session.notes !== 'string') {
    errors.push('notes must be a string if provided')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Calculates session load (duration in minutes * RPE) using calculateSessionLoad from training-load.js.
 * @param {Object} session
 * @param {number} [session.durationMs]
 * @param {number} [session.rpe]
 * @returns {number} Session load in arbitrary units (AU)
 */
export function calculateFreestyleLoad(session) {
  if (!session || typeof session !== 'object') return 0
  const durationMs = Number(session.durationMs) || 0
  const rpe = Number(session.rpe) || 0
  if (durationMs <= 0 || rpe <= 0 || !isFinite(durationMs) || !isFinite(rpe)) return 0
  return calculateSessionLoad({ durationMs, rpe })
}

/**
 * Normalizes and creates a canonical freestyle session object.
 * @param {Object} data
 * @returns {Object}
 */
export function createFreestyleSession(data = {}) {
  const kind = data.kind != null ? String(data.kind).trim().toLowerCase() : 'hiit'
  const durationMs = data.durationMs != null && !isNaN(Number(data.durationMs))
    ? Math.max(0, Number(data.durationMs))
    : 0
  const rpe = data.rpe != null && !isNaN(Number(data.rpe)) ? Number(data.rpe) : 6
  const notes = data.notes != null ? String(data.notes).trim() : ''
  const startTime = data.startTime || new Date().toISOString()
  const createdAt = data.createdAt || new Date().toISOString()
  const id = data.id || (typeof uid === 'function' ? uid() : Date.now().toString(36) + Math.random().toString(36).slice(2, 7))

  const session = {
    id,
    kind,
    durationMs,
    rpe,
    notes,
    startTime,
    createdAt
  }

  session.load = calculateFreestyleLoad(session)
  return session
}

/**
 * Formats duration in milliseconds into a timer clock string MM:SS or HH:MM:SS.
 * @param {number} ms
 * @returns {string}
 */
export function formatTimerClock(ms) {
  const safeMs = Math.max(0, Number(ms) || 0)
  const totalSeconds = Math.floor(safeMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const mStr = String(minutes).padStart(2, '0')
  const sStr = String(seconds).padStart(2, '0')

  if (hours > 0) {
    const hStr = String(hours).padStart(2, '0')
    return `${hStr}:${mStr}:${sStr}`
  }
  return `${mStr}:${sStr}`
}

/* =========================================================================
   Timed Session State Machine Helpers
   ========================================================================= */

/**
 * Initializes a running timer state for a given modality.
 * @param {string} [kind='hiit']
 * @param {number} [now=Date.now()]
 * @returns {Object}
 */
export function startFreestyleTimer(kind = 'hiit', now = Date.now()) {
  const k = isValidModality(kind) ? String(kind).trim().toLowerCase() : 'hiit'
  return {
    kind: k,
    status: 'running', // 'running' | 'paused' | 'finished'
    startTime: now,
    intervals: [{ start: now, end: null }]
  }
}

/**
 * Pauses a running timer state.
 * @param {Object} state
 * @param {number} [now=Date.now()]
 * @returns {Object}
 */
export function pauseFreestyleTimer(state, now = Date.now()) {
  if (!state || state.status !== 'running') return state
  const intervals = Array.isArray(state.intervals) ? [...state.intervals] : []
  const lastIdx = intervals.length - 1
  if (lastIdx >= 0 && intervals[lastIdx].end === null) {
    intervals[lastIdx] = { ...intervals[lastIdx], end: now }
  }

  return {
    ...state,
    status: 'paused',
    intervals
  }
}

/**
 * Resumes a paused timer state.
 * @param {Object} state
 * @param {number} [now=Date.now()]
 * @returns {Object}
 */
export function resumeFreestyleTimer(state, now = Date.now()) {
  if (!state || state.status !== 'paused') return state
  const intervals = Array.isArray(state.intervals) ? [...state.intervals] : []
  intervals.push({ start: now, end: null })

  return {
    ...state,
    status: 'running',
    intervals
  }
}

/**
 * Computes the total active elapsed milliseconds from intervals, excluding pauses.
 * @param {Object} state
 * @param {number} [now=Date.now()]
 * @returns {number}
 */
export function getFreestyleTimerElapsedMs(state, now = Date.now()) {
  if (!state || !Array.isArray(state.intervals)) return 0
  return state.intervals.reduce((total, it) => {
    if (!it || typeof it.start !== 'number') return total
    const end = it.end != null ? it.end : (state.status === 'running' ? now : it.start)
    return total + Math.max(0, end - it.start)
  }, 0)
}

/**
 * Finishes a timer session and produces a validated session object ready to be logged.
 * @param {Object} state
 * @param {Object} [details]
 * @param {number} [details.rpe=6]
 * @param {string} [details.notes='']
 * @param {number} [now=Date.now()]
 * @returns {{ timerState: Object, session: Object }}
 */
export function finishFreestyleTimer(state, { rpe = 6, notes = '' } = {}, now = Date.now()) {
  if (!state) return null
  let stoppedState = state
  if (state.status === 'running') {
    stoppedState = pauseFreestyleTimer(state, now)
  }
  const durationMs = getFreestyleTimerElapsedMs(stoppedState, now)
  const session = createFreestyleSession({
    kind: state.kind,
    durationMs,
    rpe,
    notes,
    startTime: new Date(state.startTime || now).toISOString()
  })

  return {
    timerState: {
      ...stoppedState,
      status: 'finished'
    },
    session
  }
}

/* =========================================================================
   Store Persistence Helpers
   ========================================================================= */

/**
 * Logs a freestyle session into store state (s.freestyleSessions).
 * @param {Object} sessionInput
 * @param {Object} [store=useStore]
 * @returns {Object} Logged session
 */
export function logFreestyleSession(sessionInput, store = useStore) {
  const session = createFreestyleSession(sessionInput)
  const check = validateFreestyleSession(session)
  if (!check.valid) {
    throw new Error(`Invalid freestyle session: ${check.errors.join('; ')}`)
  }

  if (store?.getState?.()?.update) {
    store.getState().update(s => {
      if (!Array.isArray(s.freestyleSessions)) s.freestyleSessions = []
      s.freestyleSessions.push(session)
    })
  } else if (store && typeof store === 'object') {
    const target = store.S || store
    if (!Array.isArray(target.freestyleSessions)) target.freestyleSessions = []
    target.freestyleSessions.push(session)
  }

  return session
}

/**
 * Retrieves all freestyle sessions from store or state object.
 * @param {Object} [storeOrState=useStore]
 * @returns {Array<Object>}
 */
export function getFreestyleSessions(storeOrState = useStore) {
  if (!storeOrState) return []
  if (typeof storeOrState.getState === 'function') {
    const st = storeOrState.getState()
    if (st?.S && Array.isArray(st.S.freestyleSessions)) return st.S.freestyleSessions
    if (Array.isArray(st?.freestyleSessions)) return st.freestyleSessions
    return []
  }
  const target = storeOrState.S || storeOrState
  return Array.isArray(target?.freestyleSessions) ? target.freestyleSessions : []
}

/**
 * Deletes a freestyle session by id from store state.
 * @param {string} id
 * @param {Object} [store=useStore]
 * @returns {Object|null} Deleted session or null
 */
export function deleteFreestyleSession(id, store = useStore) {
  let removed = null
  if (store?.getState?.()?.update) {
    store.getState().update(s => {
      if (!Array.isArray(s.freestyleSessions)) return
      const idx = s.freestyleSessions.findIndex(x => x.id === id)
      if (idx !== -1) {
        removed = s.freestyleSessions.splice(idx, 1)[0]
      }
    })
  } else if (store && typeof store === 'object') {
    const target = store.S || store
    if (Array.isArray(target.freestyleSessions)) {
      const idx = target.freestyleSessions.findIndex(x => x.id === id)
      if (idx !== -1) {
        removed = target.freestyleSessions.splice(idx, 1)[0]
      }
    }
  }
  return removed
}
