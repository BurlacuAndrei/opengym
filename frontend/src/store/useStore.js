import { create } from 'zustand'
import { api } from '../lib/api.js'
import { localTZ, uid } from '../lib/format.js'
import { registerCustom } from '../lib/exercises.js'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { MOBILE, nativeLoad, nativeSave, syncReminder } from '../lib/mobile.js'
import {
  createLocalBackup,
  exportBackup as libExportBackup,
  importBackup as libImportBackup
} from '../lib/backup.js'
import { openConflictDialog, openRegisterImportDialog } from '../components/ConflictDialog.jsx'
import { createSyncEngine, hasData } from '../lib/sync-engine.js'
import { getServerUrl, clearServerConfig } from '../lib/server-config.js'
import { clearToken } from '../lib/token-storage.js'
import * as privacy from '../lib/privacy.js'
import {
  addGear as libAddGear,
  updateGear as libUpdateGear,
  retireGear as libRetireGear,
  accumulateGearDistance as libAccumulateGearDistance,
  setGearStore
} from '../lib/gear.js'
import {
  ROUTINE_KINDS,
  DEFAULT_ROUTINE_KIND,
  getRoutineKind,
  getRoutineRestSec,
  normalizeRoutine
} from '../lib/routine-kind.js'
import { getCardioAdapter } from '../lib/cardio-adapter.js'
import {
  reconcileTracksAndRoutes,
  lazyFetchTrack,
  lazyFetchRoute,
  deleteRemoteTrack,
  deleteRemoteRoute,
  cleanupCachedServerTracks
} from '../lib/track-sync.js'
import { App as CapApp } from '@capacitor/app'

const KEY = 'gym_state_v1'
export const DEF = {
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], cardioActivities: [], gear: [], active: null, customEx: [], gifSize: 'full',
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
  privacy: { consents: {} },
  // Voice split cues (TTS with audio ducking, Issue #64). Default true.
  voiceCues: true
}
const clone = o => JSON.parse(JSON.stringify(o))

/**
 * Normalizes a session value or array into an array of non-empty string IDs (Issue #47).
 * Transparently accepts string ('r1'), array (['r1', 'r2']), or null/undefined.
 */
export function getSessions(val) {
  if (Array.isArray(val)) return val.filter(x => typeof x === 'string' && x.trim() !== '')
  if (typeof val === 'string' && val.trim() !== '') return [val]
  return []
}

/**
 * Accessor for the first session of a day, transparently handling string and array formats.
 */
export function getFirstSession(val) {
  if (Array.isArray(val)) return val[0] || null
  if (typeof val === 'string' && val.trim() !== '') return val
  return null
}

/**
 * Normalizes an entire week or dayPlan schedule mapping to session arrays.
 */
export function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(schedule)) {
    const sessions = getSessions(v)
    if (sessions.length > 0) out[k] = sessions
  }
  return out
}

/**
 * Automatically migrates legacy string week[d] and dayPlan[date] to session arrays in-place (Issue #47).
 */
export function migrateSchedule(S) {
  if (!S || typeof S !== 'object') return S
  if (S.week && typeof S.week === 'object') {
    S.week = normalizeSchedule(S.week)
  }
  if (S.dayPlan && typeof S.dayPlan === 'object') {
    S.dayPlan = normalizeSchedule(S.dayPlan)
  }
  return S
}

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const state = Object.assign(clone(DEF), JSON.parse(raw))
      return migrateSchedule(state)
    }
  } catch (e) { /* ignore */ }
  return clone(DEF)
}

export const CARDIO_TYPES = ['run', 'ride', 'hike', 'walk']

export function validateCardioActivity(act) {
  const errors = []
  if (!act || typeof act !== 'object') {
    return { valid: false, errors: ['Activity must be an object'] }
  }

  if (!act.type || !CARDIO_TYPES.includes(act.type)) {
    errors.push(`Type must be one of: ${CARDIO_TYPES.join(', ')}`)
  }

  const dur = Number(act.durationMs)
  if (act.durationMs == null || isNaN(dur) || dur <= 0 || !isFinite(dur)) {
    errors.push('Duration must be greater than 0')
  }

  if (act.distanceM != null) {
    const dist = Number(act.distanceM)
    if (isNaN(dist) || dist < 0 || !isFinite(dist)) {
      errors.push('Distance must be 0 or greater')
    }
  }

  if (act.elevationGainM != null) {
    const elev = Number(act.elevationGainM)
    if (isNaN(elev) || elev < 0 || !isFinite(elev)) {
      errors.push('Elevation gain must be 0 or greater')
    }
  }

  if (act.rpe != null) {
    const rpe = Number(act.rpe)
    if (isNaN(rpe) || rpe < 1 || rpe > 10) {
      errors.push('RPE must be between 1 and 10')
    }
  }

  if (act.calories != null) {
    const cal = Number(act.calories)
    if (isNaN(cal) || cal < 0 || !isFinite(cal)) {
      errors.push('Calories must be 0 or greater')
    }
  }

  if (act.startTime != null) {
    const ts = new Date(act.startTime).getTime()
    if (isNaN(ts)) {
      errors.push('Start time must be a valid date or timestamp')
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

export function normalizeCardioActivity(act = {}) {
  const durationMs = Math.max(0, Number(act.durationMs) || 0)
  const distanceM = act.distanceM != null ? Math.max(0, Number(act.distanceM) || 0) : 0
  const elevationGainM = act.elevationGainM != null ? Math.max(0, Number(act.elevationGainM) || 0) : 0

  let avgPaceSecKm = act.avgPaceSecKm != null ? Number(act.avgPaceSecKm) : null
  let avgSpeedKmh = act.avgSpeedKmh != null ? Number(act.avgSpeedKmh) : null

  if (avgPaceSecKm == null && durationMs > 0 && distanceM > 0) {
    avgPaceSecKm = durationMs / distanceM
  }
  if (avgSpeedKmh == null && durationMs > 0 && distanceM > 0) {
    avgSpeedKmh = (distanceM * 3600) / durationMs
  }

  const type = CARDIO_TYPES.includes(act.type) ? act.type : 'run'
  const startTime = act.startTime || new Date().toISOString()

  return {
    id: act.id || uid(),
    type,
    startTime,
    durationMs,
    distanceM,
    elevationGainM,
    avgPaceSecKm: avgPaceSecKm != null && isFinite(avgPaceSecKm) ? avgPaceSecKm : null,
    avgSpeedKmh: avgSpeedKmh != null && isFinite(avgSpeedKmh) ? avgSpeedKmh : null,
    calories: act.calories != null ? Math.max(0, Number(act.calories) || 0) : null,
    rpe: act.rpe != null ? Math.min(10, Math.max(1, Number(act.rpe) || 0)) : null,
    notes: act.notes != null ? String(act.notes) : '',
    gearId: act.gearId || null
  }
}

export const useStore = create((set, get) => {
  const syncEngine = createSyncEngine({
    getState: get,
    setState: set,
    storageKey: KEY,
    def: DEF,
    debounceMs: 1500,
    migrateSchedule,
    createLocalBackup,
    onConflict: ({ serverState, resolveConflict }) => {
      openConflictDialog({ serverState, resolveConflict })
    },
    onRegisterImport: (opts) => {
      openRegisterImportDialog(opts)
    },
    reconcileTracksAndRoutes: () => reconcileTracksAndRoutes({ store: useStore }),
    cleanupCachedServerTracks,
    getCardioAdapter,
  })

  const persist = (S, push = true) => syncEngine.persist(S, push)

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
    replaceState(S, push = false) {
      let stateToPersist = S
      if (S && S.state && (S.tracks || S.routeFiles || S.version)) {
        stateToPersist = S.state
      }
      persist(clone(stateToPersist), push)
      if (S && (S.tracks || S.routeFiles)) {
        const adapter = getCardioAdapter()
        if (S.tracks) {
          for (const [key, track] of Object.entries(S.tracks)) {
            if (track) adapter.writeTrack(key, track).catch(() => {})
          }
        }
        if (S.routeFiles) {
          for (const [key, route] of Object.entries(S.routeFiles)) {
            if (route) adapter.writeTrack(key, route).catch(() => {})
          }
        }
        if (get().isServerMode?.() || get().user) {
          reconcileTracksAndRoutes({ store: useStore }).catch(() => {})
        }
      }
    },

    // Session array accessors and mutators (Issue #47)
    getDayPlan(date) {
      return getSessions(get().S?.dayPlan?.[date])
    },
    getWeekPlan(day) {
      return getSessions(get().S?.week?.[day])
    },
    setDayPlan(date, val) {
      get().update(s => {
        if (!s.dayPlan) s.dayPlan = {}
        const sessions = getSessions(val)
        if (sessions.length === 0) {
          delete s.dayPlan[date]
        } else {
          s.dayPlan[date] = sessions
        }
      })
    },
    setWeekPlan(day, val) {
      get().update(s => {
        if (!s.week) s.week = {}
        const sessions = getSessions(val)
        if (sessions.length === 0) {
          delete s.week[day]
        } else {
          s.week[day] = sessions
        }
      })
    },

    // Routine kind and rest timer management (Issue #59)
    getRoutineKind(id) {
      const r = get().S?.routines?.find(x => x.id === id)
      return getRoutineKind(r)
    },
    getRoutineRestSec(id) {
      const r = get().S?.routines?.find(x => x.id === id)
      return getRoutineRestSec(r, get().S?.restSec)
    },
    setRoutineKind(id, kind) {
      get().update(s => {
        const r = s.routines?.find(x => x.id === id)
        if (r) r.kind = ROUTINE_KINDS.includes(kind) ? kind : DEFAULT_ROUTINE_KIND
      })
    },
    setRoutineRestSec(id, restSec) {
      get().update(s => {
        const r = s.routines?.find(x => x.id === id)
        if (r) {
          if (restSec == null || restSec === 0 || restSec === '') delete r.restSec
          else {
            const val = Number(restSec)
            if (Number.isFinite(val) && val >= 0) r.restSec = val
            else delete r.restSec
          }
        }
      })
    },

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

    // Manual cardio activity logging (Issue #45)
    logCardioActivity(act) {
      const activity = normalizeCardioActivity(act)
      get().update(s => {
        if (!Array.isArray(s.cardioActivities)) s.cardioActivities = []
        s.cardioActivities.push(activity)
      })
      if (activity.gearId && activity.distanceM > 0) {
        libAccumulateGearDistance(activity.gearId, activity.distanceM, set, get)
      }
      return activity
    },
    // Gear mileage tracking (Issue #54)
    addGear(gear) {
      return libAddGear(gear, set, get)
    },
    updateGear(id, patch) {
      return libUpdateGear(id, patch, set, get)
    },
    retireGear(id) {
      return libRetireGear(id, set, get)
    },
    accumulateGearDistance(gearId, distanceM) {
      return libAccumulateGearDistance(gearId, distanceM, set, get)
    },
    updateCardioActivity(id, patch = {}) {
      let updated = null
      get().update(s => {
        if (!Array.isArray(s.cardioActivities)) s.cardioActivities = []
        const idx = s.cardioActivities.findIndex(a => a.id === id)
        if (idx !== -1) {
          const current = s.cardioActivities[idx]
          const next = { ...current, ...patch }

          const durationMs = next.durationMs != null ? Math.max(0, Number(next.durationMs) || 0) : 0
          const distanceM = next.distanceM != null ? Math.max(0, Number(next.distanceM) || 0) : 0

          if (patch.avgPaceSecKm === undefined && (patch.durationMs !== undefined || patch.distanceM !== undefined)) {
            next.avgPaceSecKm = (distanceM > 0 && durationMs > 0) ? (durationMs / distanceM) : null
          }
          if (patch.avgSpeedKmh === undefined && (patch.durationMs !== undefined || patch.distanceM !== undefined)) {
            next.avgSpeedKmh = (distanceM > 0 && durationMs > 0) ? ((distanceM * 3600) / durationMs) : null
          }
          if (patch.type && CARDIO_TYPES.includes(patch.type)) {
            next.type = patch.type
          }

          s.cardioActivities[idx] = next
          updated = next
        }
      })
      return updated
    },
    deleteCardioActivity(id) {
      let removed = null
      get().update(s => {
        if (!Array.isArray(s.cardioActivities)) s.cardioActivities = []
        const idx = s.cardioActivities.findIndex(a => a.id === id)
        if (idx !== -1) {
          removed = s.cardioActivities[idx]
          s.cardioActivities.splice(idx, 1)
        }
      })
      if (removed) {
        const trackPath = removed.trackPath || (removed.id ? `${removed.id}.json` : '')
        if (trackPath) {
          getCardioAdapter().deleteTrack(trackPath).catch(() => {})
        }
        if (get().isServerMode?.() || get().user) {
          deleteRemoteTrack(id).catch(() => {})
        }
      }
      return removed
    },
    deleteRoute(id) {
      let removed = null
      get().update(s => {
        if (Array.isArray(s.routes)) {
          const idx = s.routes.findIndex(r => r.id === id)
          if (idx !== -1) {
            removed = s.routes[idx]
            s.routes.splice(idx, 1)
          }
        }
        if (Array.isArray(s.savedRoutes)) {
          const idx = s.savedRoutes.findIndex(r => r.id === id)
          if (idx !== -1) {
            if (!removed) removed = s.savedRoutes[idx]
            s.savedRoutes.splice(idx, 1)
          }
        }
      })
      if (removed || id) {
        const trackPath = removed?.trackPath || `routes/${id}.json`
        getCardioAdapter().deleteTrack(trackPath).catch(() => {})
        if (get().isServerMode?.() || get().user) {
          deleteRemoteRoute(id).catch(() => {})
        }
      }
      return removed
    },
    reconcileTracks(options) {
      return reconcileTracksAndRoutes({ store: useStore, ...options })
    },
    lazyFetchTrack(id, options) {
      return lazyFetchTrack(id, { store: useStore, ...options })
    },
    lazyFetchRoute(id, options) {
      return lazyFetchRoute(id, { store: useStore, ...options })
    },
    async exportBackup(options = {}) {
      return libExportBackup(get().S, { store: useStore, ...options })
    },
    async importBackup(backupData, options = {}) {
      return libImportBackup(backupData, { store: useStore, ...options })
    },

    isServerMode: () => Boolean(get().user && (!MOBILE || getServerUrl())),
    isGuest: () => localStorage.getItem('gym_guest') === '1',
    setGuest(v) { if (v) localStorage.setItem('gym_guest', '1'); else localStorage.removeItem('gym_guest'); set({}) },

    setUser(u) {
      if (u) { localStorage.setItem('gym_user', JSON.stringify(u)); localStorage.removeItem('gym_guest') }
      else localStorage.removeItem('gym_user')
      set({ user: u, sessionExpired: false, reAuthNeeded: false })
    },

    syncEngine,
    persist,
    flushPending: () => syncEngine.flushPending(),
    pushState: () => syncEngine.pushState(),
    pullState: (prefetchedState) => syncEngine.pullState(prefetchedState),
    handleResume: () => syncEngine.handleResume(),
    handleOnline: () => syncEngine.handleOnline(),
    reconcileOnRegister: (choice, serverData) => syncEngine.reconcileOnRegister(choice, serverData),
    reconcileOnConnect: (serverData) => syncEngine.reconcileOnConnect(serverData),
    handleReauth: (newUser, serverData) => syncEngine.handleReauth(newUser, serverData),
    disconnectServer: (opts) => syncEngine.disconnectServer(opts),
    resolveConflict: (choice, serverState) => syncEngine.resolveConflict(choice, serverState),

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
export const logCardioActivity = (act) => useStore.getState().logCardioActivity(act)
export const updateCardioActivity = (id, patch) => useStore.getState().updateCardioActivity(id, patch)
export const deleteCardioActivity = (id) => useStore.getState().deleteCardioActivity(id)
export const deleteRoute = (id) => useStore.getState().deleteRoute(id)
export const reconcileTracks = (options) => useStore.getState().reconcileTracks(options)
export const lazyFetchTrackStore = (id, options) => useStore.getState().lazyFetchTrack(id, options)
export const lazyFetchRouteStore = (id, options) => useStore.getState().lazyFetchRoute(id, options)
export const exportBackup = (options) => useStore.getState().exportBackup(options)
export const importBackup = (backupData, options) => useStore.getState().importBackup(backupData, options)
setGearStore(useStore)
export const addGear = (gear) => useStore.getState().addGear(gear)
export const updateGear = (id, patch) => useStore.getState().updateGear(id, patch)
export const retireGear = (id) => useStore.getState().retireGear(id)
export const accumulateGearDistance = (gearId, distanceM) => useStore.getState().accumulateGearDistance(gearId, distanceM)
export { ROUTINE_KINDS, DEFAULT_ROUTINE_KIND, getRoutineKind, getRoutineRestSec, normalizeRoutine } from '../lib/routine-kind.js'
export const getRoutineKindById = (id) => useStore.getState().getRoutineKind(id)
export const getRoutineRestSecById = (id) => useStore.getState().getRoutineRestSec(id)
export const setRoutineKind = (id, kind) => useStore.getState().setRoutineKind(id, kind)
export const setRoutineRestSec = (id, restSec) => useStore.getState().setRoutineRestSec(id, restSec)

