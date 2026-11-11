import { create } from 'zustand'
import { api } from '../lib/api.js'
import { localTZ } from '../lib/format.js'
import { registerCustom } from '../lib/exercises.js'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { MOBILE, nativeLoad, nativeSave, syncReminder } from '../lib/mobile.js'
import { createLocalBackup } from '../lib/backup.js'
import { openConflictDialog, openRegisterImportDialog } from '../components/ConflictDialog.jsx'
import { getServerUrl, clearServerConfig } from '../lib/server-config.js'
import { clearToken } from '../lib/token-storage.js'
import * as privacy from '../lib/privacy.js'
import { App as CapApp } from '@capacitor/app'

const KEY = 'gym_state_v1'
export const DEF = {
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], gifSize: 'full',
  // effort: which per-set effort scale is logged — 'none' | 'rir' | 'rpe'. null, not 'none', so
  // that a profile which never chose (loaded state is overlaid on DEF, on every path: local,
  // server pull, backup import) still falls back to the `showRir` boolean this replaced and
  // keeps the column it had. See effortOf.
  reminder: { on: false, time: '08:00', tz: null }, effort: null,
  // AI Coach (issue: AI enablement). null until the profile opts in — a null namespace is the
  // same app it was before the feature existed, which is what Epic F asks for. Shape and
  // bounds live in lib/coach.js.
  coach: null,
  // Informed consent records for external features (Issue #39).
  privacy: { consents: {} }
}
const clone = o => JSON.parse(JSON.stringify(o))

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return Object.assign(clone(DEF), JSON.parse(raw))
  } catch (e) { /* ignore */ }
  return clone(DEF)
}

const hasData = st => !!(st && ((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length))

export const useStore = create((set, get) => {
  let pushTm = null
  let saveTm = null

  // Mobile build: mirror the state into a file in the app's data directory (survives WebView
  // storage eviction) and keep the native reminder schedule in step with the weekly plan.
  const nativePersist = () => {
    clearTimeout(saveTm)
    saveTm = setTimeout(() => { saveTm = null; nativeSave(get().S); syncReminder(get().S) }, 800)
  }

  const persist = (S, push = true) => {
    S._ts = Date.now()
    registerCustom(S.customEx)
    localStorage.setItem(KEY, JSON.stringify(S))
    set({ S })
    if (MOBILE) nativePersist()
    if (push && get().user) {
      clearTimeout(pushTm)
      pushTm = setTimeout(() => get().pushState(), 1500)
    }
  }

  // A setting changed right before switching away/closing the tab must not get lost mid-debounce
  // (e.g. setting the reminder time then immediately backgrounding to test it). On mobile the
  // same applies to the file mirror — backgrounding is often the last thing before the OS
  // kills the app.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return
      if (MOBILE && saveTm) {
        clearTimeout(saveTm)
        saveTm = null
        nativeSave(get().S)
      }
      if (pushTm) {
        clearTimeout(pushTm)
        pushTm = null
        get().pushState()
      }
    })
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => get().handleOnline?.())
  }

  try {
    CapApp?.addListener?.('resume', () => get().handleResume?.())?.catch?.(() => {})
  } catch (e) { /* ignore */ }

  // Everything a sign-out leaves behind on this device, whichever way it was triggered.
  const clearLocalSession = () => {
    get().setUser(null)
    localStorage.removeItem('gym_guest')
    localStorage.removeItem('gym_dirty')
    localStorage.removeItem('gym_last_synced_ts')
    localStorage.removeItem(KEY)
    clearToken().catch(() => {})
    persist(clone(DEF), false)
  }

  return {
    S: (() => { const s = loadState(); registerCustom(s.customEx); return s })(),
    user: (() => { try { return JSON.parse(localStorage.getItem('gym_user')) || null } catch { return null } })(),
    ready: false,
    sessionExpired: false,
    reAuthNeeded: false,
    // Instance capabilities from GET /api/config. `config.coach` is present only when the
    // owner has both enabled the Coach and connected a provider — every Coach entry point in
    // the app hangs off it, so an unconfigured instance renders exactly what it always did.
    config: null,

    // Mutate a draft of S via producer fn, then persist + schedule sync.
    update(mut, push = true) {
      const S = clone(get().S)
      mut(S)
      persist(S, push)
    },
    replaceState(S, push = false) { persist(clone(S), push) },

    // Privacy and consent management (Issue #39)
    grantConsent(featureId, details = {}) {
      get().update(s => {
        privacy.grantConsent(s, featureId, details)
      })
    },
    revokeConsent(featureId) {
      get().update(s => {
        privacy.revokeConsent(s, featureId)
      })
    },
    hasConsent(featureId) {
      return privacy.hasConsent(get().S, featureId)
    },
    getConsent(featureId) {
      return privacy.getConsent(get().S, featureId)
    },

    isServerMode: () => Boolean(get().user && (!MOBILE || getServerUrl())),
    isGuest: () => localStorage.getItem('gym_guest') === '1',
    setGuest(v) { if (v) localStorage.setItem('gym_guest', '1'); else localStorage.removeItem('gym_guest'); set({}) },

    setUser(u) {
      if (u) { localStorage.setItem('gym_user', JSON.stringify(u)); localStorage.removeItem('gym_guest') }
      else localStorage.removeItem('gym_user')
      set({ user: u, sessionExpired: false, reAuthNeeded: false })
    },

    async pushState() {
      if (!get().user) return
      clearTimeout(pushTm)
      try {
        const rawTs = localStorage.getItem('gym_last_synced_ts')
        const baseTs = rawTs && !Number.isNaN(Number(rawTs)) ? Number(rawTs) : undefined
        const body = { state: get().S }
        if (baseTs !== undefined) body.baseTs = baseTs
        const res = await api('/api/data', { method: 'PUT', body: JSON.stringify(body) })
        localStorage.setItem('gym_last_synced_ts', String(res?.ts || get().S._ts || ''))
        localStorage.removeItem('gym_dirty')
        if (MOBILE) nativeSave(get().S)
      } catch (e) {
        localStorage.setItem('gym_dirty', '1')
        if (e.status === 409 || e.statusCode === 409) {
          openConflictDialog({ serverState: e.serverState || e.state || e.data?.state || e.data?.serverState })
        } else if (e.status === 401 || e.statusCode === 401) {
          set({ sessionExpired: true, reAuthNeeded: true })
        }
      }
    },
    async pullState(prefetchedState) {
      try {
        const state = prefetchedState !== undefined ? prefetchedState : (await api('/api/data'))?.state
        const S = get().S
        const dirty = localStorage.getItem('gym_dirty') === '1'
        if (state && dirty && (state._ts || 0) > (S._ts || 0)) {
          openConflictDialog({ serverState: state })
        } else if (state && (!hasData(S) || ((state._ts || 0) >= (S._ts || 0) && !dirty))) {
          const active = S.active
          const next = Object.assign(clone(DEF), state)
          if (active) next.active = active
          persist(next, false)
          if (state._ts) localStorage.setItem('gym_last_synced_ts', String(state._ts))
        } else if (hasData(S)) { await get().pushState() }
      } catch (e) {
        if (e.status === 401 || e.statusCode === 401) {
          set({ sessionExpired: true, reAuthNeeded: true })
        }
        /* offline — keep local */
      }
    },

    async handleResume() {
      if (!get().isServerMode()) return
      await get().pullState()
    },

    async handleOnline() {
      if (!get().isServerMode()) return
      const dirty = localStorage.getItem('gym_dirty') === '1'
      if (dirty) {
        await get().pushState()
      } else {
        await get().pullState()
      }
    },

    async reconcileOnRegister(choice, serverData) {
      const S = get().S
      const phoneHasData = hasData(S)
      if (!phoneHasData) {
        await get().pullState(serverData)
        return
      }

      const c = typeof choice === 'string' ? choice.toLowerCase() : choice
      if (c === 'upload' || c === true) {
        await get().pushState()
        return
      }

      if (c === 'decline' || c === 'fresh' || c === false) {
        createLocalBackup(S)
        let serverState = serverData
        if (serverState === undefined) {
          try {
            const res = await api('/api/data')
            serverState = res?.state ?? null
          } catch (e) {
            serverState = null
          }
        }
        const next = Object.assign(clone(DEF), serverState || {})
        get().replaceState(next, false)
        if (serverState?._ts) localStorage.setItem('gym_last_synced_ts', String(serverState._ts))
        else localStorage.removeItem('gym_last_synced_ts')
        localStorage.removeItem('gym_dirty')
        if (MOBILE) nativeSave(get().S)
        return
      }

      openRegisterImportDialog({
        onChoice: async userChoice => {
          await get().reconcileOnRegister(userChoice, serverData)
        }
      })
    },

    async reconcileOnConnect(serverData) {
      let serverState = serverData
      if (serverState === undefined) {
        try {
          const res = await api('/api/data')
          serverState = res?.state ?? null
        } catch (e) {
          return
        }
      }

      const S = get().S
      const phoneHasData = hasData(S)
      const serverHasData = hasData(serverState)

      if (phoneHasData && serverHasData) {
        createLocalBackup(S)
        openConflictDialog({ serverState })
      } else if (!phoneHasData && serverHasData) {
        await get().pullState(serverState)
      } else if (phoneHasData && !serverHasData) {
        await get().pushState()
      }
    },

    async handleReauth(newUser, serverData) {
      const prevUser = get().user
      const isSame = Boolean(prevUser?.id && newUser?.id && prevUser.id === newUser.id)

      if (isSame) {
        get().setUser(newUser)
        const dirty = localStorage.getItem('gym_dirty') === '1'
        if (dirty) {
          await get().pushState()
        }
      } else {
        createLocalBackup(get().S)
        localStorage.removeItem('gym_dirty')
        localStorage.removeItem('gym_last_synced_ts')
        get().setUser(newUser)
        await get().reconcileOnConnect(serverData)
      }
    },

    async disconnectServer(opts = {}) {
      const removeData = typeof opts === 'boolean' ? opts : Boolean(opts?.removeData)
      clearTimeout(pushTm)
      await clearToken().catch(() => {})
      clearServerConfig()
      get().setUser(null)
      get().setGuest(true)
      localStorage.removeItem('gym_dirty')
      localStorage.removeItem('gym_last_synced_ts')
      if (removeData) {
        persist(clone(DEF), false)
      } else {
        if (MOBILE) {
          nativeSave(get().S)
        }
      }
    },

    async resolveConflict(choice, serverState) {
      const c = (choice || '').toLowerCase()
      if (c === 'server') {
        createLocalBackup(get().S)
        if (serverState) {
          const active = get().S?.active
          const next = Object.assign(clone(DEF), serverState)
          if (active) next.active = active
          get().replaceState(next, false)
          if (serverState._ts) localStorage.setItem('gym_last_synced_ts', String(serverState._ts))
        }
        localStorage.removeItem('gym_dirty')
      } else if (c === 'device') {
        await get().pushState()
      }
    },

    async signOut() {
      try { await get().pushState(); await api('/api/logout', { method: 'POST', body: '{}' }) } catch (e) { /* */ }
      clearLocalSession()
    },

    // "Sign out everywhere": the server bumps this profile's session version, which kills every
    // session it has on any device — this browser included, so the app has to end up exactly
    // where a normal signOut leaves it. Unlike signOut the request is NOT swallowed: if it fails
    // the sessions elsewhere are all still valid, and wiping this device's copy of the data
    // would sign the user out of the one place the bump didn't reach. Caller reports the error.
    async signOutAll() {
      await get().pushState()   // never throws — stores gym_dirty and moves on when offline
      await api('/api/logout/all', { method: 'POST', body: '{}' })
      clearLocalSession()
    },

    // Demo build only: drop the seeded example profile back in (Settings → "Reset demo data").
    // Dynamic import so the generator never ships in a self-hosted bundle.
    async resetDemo() {
      const { buildDemoState } = await import('../lib/demoSeed.js')
      localStorage.removeItem('gym_dirty')
      persist(Object.assign(clone(DEF), buildDemoState()), false)
    },

    // Boot: ask the server who we are, then pull.
    async boot() {
      // Mobile build: no backend either — restore from the file mirror (the durable copy;
      // localStorage may have been evicted since the last run) and go straight in.
      if (MOBILE) {
        const saved = await nativeLoad()
        const S = get().S
        if (saved && (!hasData(S) || (saved._ts || 0) >= (S._ts || 0))) {
          persist(Object.assign(clone(DEF), saved), false)
        } else if (hasData(S)) {
          nativeSave(S)   // first run after an update from a file-less version: seed the mirror
        }
        const serverUrl = getServerUrl()
        const user = get().user
        if (serverUrl && user) {
          await get().pullState()
        } else {
          get().setGuest(true)
        }
        syncReminder(get().S)
        set({ ready: true })
        return
      }
      // Demo build (GitHub Pages): no backend at all — seed once, stay in guest mode.
      if (DEMO) {
        if (!localStorage.getItem(DEMO_SEEDED)) {
          localStorage.setItem(DEMO_SEEDED, '1')
          await get().resetDemo()
        }
        get().setGuest(true)
        set({ ready: true })
        return
      }
      // Instance capabilities are public and needed whether or not anyone is signed in.
      try { set({ config: await api('/api/config') }) } catch (e) { /* offline — assume nothing extra */ }
      try {
        const me = await api('/api/me')
        get().setUser(me.user)
        await get().pullState()
        // Re-stamp the reminder's timezone on every load — keeps it correct if you're travelling,
        // without needing to revisit Settings.
        const tz = localTZ()
        if (get().S.reminder?.on && get().S.reminder.tz !== tz) {
          get().update(s => { s.reminder = { ...s.reminder, tz } })
        }
      } catch (e) {
        if (e.status === 401) get().setUser(null)
      }
      set({ ready: true })
    }
  }
})

export { hasData }
privacy.setPrivacyStore(useStore)
export const grantConsent = (featureId, details) => useStore.getState().grantConsent(featureId, details)
export const revokeConsent = (featureId) => useStore.getState().revokeConsent(featureId)
export const hasConsent = (featureId) => useStore.getState().hasConsent(featureId)
export const getConsent = (featureId) => useStore.getState().getConsent(featureId)
export const resolveConflict = (choice, serverState) => useStore.getState().resolveConflict(choice, serverState)
export const reconcileOnConnect = (serverState) => useStore.getState().reconcileOnConnect(serverState)
export const reconcileOnRegister = (choice, serverState) => useStore.getState().reconcileOnRegister(choice, serverState)
export const disconnectServer = (opts) => useStore.getState().disconnectServer(opts)
export const handleReauth = (newUser, serverData) => useStore.getState().handleReauth(newUser, serverData)
