// Talking to the Coach endpoints, and knowing when to stop.
//
// Unifies Server, Android BYOK, and Demo Coach execution behind a single Coach client interface
// so UI views never branch on execution mode. Jobs are minutes-scale, so Server mode polls
// while in-memory BYOK mode subscribes to reactive status transitions without HTTP timers.

import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from './api.js'
import { DEMO } from './demo.js'
import { MOBILE } from './mobile.js'
import { useStore } from '../store/useStore.js'
import {
  isByokActive,
  getByokStatus,
  subscribeByokStatus,
  runByokReview,
  runByokPlan,
  resolveByokPending,
  clearByokPending,
  resetByokState,
  byokDisclosure,
  getByokKey
} from './coach-byok.js'

const POLL_MS = 3000        // a job is running: often enough to feel live
const IDLE_MS = 60000       // a Coach screen is open but nothing is running

// The demo build has no backend, so it answers these locally with a canned proposal built
// from its own seeded profile (lib/coach-demo.js). Everything downstream — validation,
// staleness, apply, revert, the log — runs unchanged; only the provider is faked. The module
// is imported dynamically so none of it lands in a self-hosted bundle.
let demoMod = null
const demo = async () => (demoMod = demoMod || await import('./coach-demo.js'))
const S = () => useStore.getState().S

let cachedByokKey = null
let byokKeyLoaded = false

export function getCachedByokKey() {
  return cachedByokKey
}

export function setCachedByokKey(key) {
  cachedByokKey = key
  byokKeyLoaded = true
}

export function resetCachedByokKey() {
  cachedByokKey = null
  byokKeyLoaded = false
}

export async function preloadByokKey() {
  if (byokKeyLoaded) return cachedByokKey
  try {
    cachedByokKey = await getByokKey()
  } catch {
    cachedByokKey = null
  }
  byokKeyLoaded = true
  return cachedByokKey
}

/**
 * Resolves active Coach execution mode: 'demo' | 'byok' | 'server'
 */
export async function getActiveMode() {
  if (DEMO) return 'demo'
  const store = useStore.getState()
  const config = store.config
  const user = store.user
  if (config?.coach?.enabled && user) return 'server'
  if (!MOBILE) return 'server'

  let key = cachedByokKey
  if (!byokKeyLoaded) {
    try {
      key = await getByokKey()
      cachedByokKey = key
      byokKeyLoaded = true
    } catch {
      key = null
    }
  }
  if (isByokActive({ config, user, mobile: MOBILE, byokKey: key })) {
    return 'byok'
  }
  return 'server'
}

export const coachStatus = async () => {
  const mode = await getActiveMode()
  if (mode === 'demo') return (await demo()).demoStatus()
  if (mode === 'byok') return getByokStatus()
  return api('/api/coach/status')
}

export const requestReview = async note => {
  const mode = await getActiveMode()
  if (mode === 'demo') return (await demo()).demoReview(S())
  if (mode === 'byok') return runByokReview({ S: S(), note })
  return api('/api/coach/review', { method: 'POST', body: JSON.stringify({ note: note || '' }) })
}

export const requestPlan = async intake => {
  const mode = await getActiveMode()
  if (mode === 'demo') return (await demo()).demoPlan(S(), intake)
  if (mode === 'byok') return runByokPlan({ S: S(), intake })
  return api('/api/coach/plan', { method: 'POST', body: JSON.stringify({ intake }) })
}

export const refinePlan = async text => {
  const mode = await getActiveMode()
  if (mode === 'demo') return (await demo()).demoRefine(S())
  if (mode === 'byok') return runByokPlan({ S: S(), refine: text })
  return api('/api/coach/plan', { method: 'POST', body: JSON.stringify({ refine: text }) })
}

export const resolvePending = async body => {
  const mode = await getActiveMode()
  if (mode === 'demo') return (await demo()).demoResolve()
  if (mode === 'byok') {
    if (body?.dismissed) {
      clearByokPending()
    } else {
      resolveByokPending()
    }
    return { ok: true }
  }
  return api('/api/coach/pending/resolve', { method: 'POST', body: JSON.stringify(body) })
}

export const forgetCoach = async () => {
  const mode = await getActiveMode()
  if (mode === 'demo') return (await demo()).demoResolve()
  if (mode === 'byok') {
    resetByokState()
    return { ok: true }
  }
  return api('/api/coach/forget', { method: 'POST', body: '{}' })
}

export const disclosure = async () => {
  const mode = await getActiveMode()
  if (mode === 'demo') return (await demo()).demoDisclosure()
  if (mode === 'byok') return byokDisclosure()
  return api('/api/coach/disclosure')
}

/**
 * Unified Coach availability hook.
 *
 * Computes availability synchronously when Server or Demo mode is active,
 * while caching the mobile BYOK key at the module level so synchronous SSR/test
 * renders execute without artificial delay.
 */
export function useCoachAvailable(configOverride, userOverride) {
  const storeConfig = useStore(s => s.config)
  const storeUser = useStore(s => s.user)
  const state = typeof useStore.getState === 'function' ? useStore.getState() : {}
  const config = configOverride !== undefined ? configOverride : (storeConfig ?? state.config)
  const user = userOverride !== undefined ? userOverride : (storeUser ?? state.user)

  const serverOrDemo = Boolean(DEMO || (config?.coach?.enabled && user))
  const [byokKey, setKey] = useState(cachedByokKey)
  const [loaded, setLoaded] = useState(byokKeyLoaded || !MOBILE || serverOrDemo)

  useEffect(() => {
    if (!MOBILE || serverOrDemo) return
    let cancelled = false
    getByokKey().then(k => {
      cachedByokKey = k
      byokKeyLoaded = true
      if (!cancelled) {
        setKey(k)
        setLoaded(true)
      }
    }).catch(() => {
      byokKeyLoaded = true
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [serverOrDemo])

  if (serverOrDemo) return true
  if (!MOBILE) return false
  if (!loaded && !cachedByokKey) return undefined
  return Boolean(byokKey || cachedByokKey)
}

/**
 * Live job/proposal state.
 *
 * `active` lets a caller (the Home card) subscribe only while it is mounted and visible;
 * everything else keeps the poll off. In BYOK mode, subscribes directly to in-memory
 * status transitions with zero HTTP polling timers.
 */
export function useCoachStatus(active = true) {
  const [state, setState] = useState({ job: null, pending: null, cap: null, loading: true })
  const timer = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const s = await coachStatus()
      setState({ ...s, loading: false })
      return s
    } catch {
      setState(s => ({ ...s, loading: false }))
      return null
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let stopped = false
    let unsubscribe = null

    const init = async () => {
      const mode = await getActiveMode()
      if (stopped) return

      if (mode === 'byok') {
        const s = getByokStatus()
        setState({ ...s, loading: false })
        unsubscribe = subscribeByokStatus(status => {
          if (!stopped) {
            setState({ ...status, loading: false })
          }
        })
      } else {
        const tick = async () => {
          const s = await refresh()
          if (stopped) return
          timer.current = setTimeout(tick, s?.job ? POLL_MS : IDLE_MS)
        }
        tick()
      }
    }

    init()

    return () => {
      stopped = true
      clearTimeout(timer.current)
      if (unsubscribe) unsubscribe()
    }
  }, [active, refresh])

  return { ...state, refresh }
}

// Server failure classes, in the app's voice.
export const JOB_ERRORS = {
  off: 'The Coach isn’t set up on this instance.',
  busy: 'The Coach is already thinking about your training.',
  cap: 'The Coach is resting — try again tomorrow.',
  consent: 'The Coach needs your go-ahead first.',
  timeout: 'The Coach took too long and gave up.',
  auth: 'The Coach couldn’t sign in to its provider — the instance owner needs to check its setup.',
  missing: 'The Coach isn’t installed properly on this instance.',
  provider: 'The Coach couldn’t run — the instance owner needs to check its setup.',
  unusable: 'The Coach answered with something the app couldn’t use.',
  restart: 'The server restarted while the Coach was thinking.',
  nostate: 'The Coach couldn’t read your training data.',
  internal: 'Something went wrong on the server.'
}
