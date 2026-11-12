import { api as defaultApi } from './api.js'
import * as mobile from './mobile.js'
import { registerCustom as defaultRegisterCustom } from './exercises.js'
import { clearToken as defaultClearToken } from './token-storage.js'
import { clearServerConfig as defaultClearServerConfig } from './server-config.js'
import { App as CapApp } from '@capacitor/app'

const defaultNativeSave = (...args) => mobile.nativeSave?.(...args)
const defaultSyncReminder = (...args) => mobile.syncReminder?.(...args)

const defaultCreateLocalBackup = (state, timestamp = Date.now()) => {
  import('./backup.js').then(m => m.createLocalBackup?.(state, timestamp)).catch(() => {})
}

const clone = o => (o ? JSON.parse(JSON.stringify(o)) : o)

export const hasData = st => !!(st && ((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length || (st.cardioActivities || []).length || (st.gear || []).length))

export function createSyncEngine(options = {}) {
  const {
    getState,
    setState,
    storageKey = 'gym_state_v1',
    def = {},
    debounceMs = 1500,
    onConflict,
    onRegisterImport,
    reconcileTracksAndRoutes,
    cleanupCachedServerTracks,
    getCardioAdapter,
    migrateSchedule: migrateScheduleFn,
    registerCustom: registerCustomFn = defaultRegisterCustom,
    nativeSave: nativeSaveFn = defaultNativeSave,
    syncReminder: syncReminderFn = defaultSyncReminder,
    createLocalBackup: createLocalBackupFn = defaultCreateLocalBackup,
    clearToken: clearTokenFn = defaultClearToken,
    clearServerConfig: clearServerConfigFn = defaultClearServerConfig,
    attachListeners = true,
  } = options

  const api = options.api || defaultApi

  const getStorage = () => options.storage || (typeof localStorage !== 'undefined' ? localStorage : null)

  const storage = {
    getItem: k => getStorage()?.getItem(k) ?? null,
    setItem: (k, v) => getStorage()?.setItem(k, v),
    removeItem: k => getStorage()?.removeItem(k)
  }

  const isServerMode = () => {
    const s = getState?.()
    if (s?.isServerMode) return s.isServerMode()
    return Boolean(s?.user)
  }

  const isMobile = () => (options.mobile !== undefined ? options.mobile : Boolean(mobile.MOBILE))

  let pushTm = null
  let saveTm = null

  const persist = (S, push = true) => {
    migrateScheduleFn?.(S)
    S._ts = Date.now()
    registerCustomFn?.(S.customEx)
    storage.setItem(storageKey, JSON.stringify(S))
    setState?.({ S })
    if (isMobile()) {
      clearTimeout(saveTm)
      saveTm = setTimeout(() => {
        saveTm = null
        nativeSaveFn?.(getState().S)
        syncReminderFn?.(getState().S)
      }, 800)
    }
    if (push && getState?.()?.user) {
      clearTimeout(pushTm)
      pushTm = setTimeout(() => {
        pushTm = null
        pushState()
      }, debounceMs)
    }
    return S
  }

  const flushPending = async () => {
    if (isMobile() && saveTm) {
      clearTimeout(saveTm)
      saveTm = null
      nativeSaveFn?.(getState().S)
    }
    if (pushTm) {
      clearTimeout(pushTm)
      pushTm = null
      return await pushState()
    }
  }

  const pushState = async () => {
    if (!getState?.()?.user) return
    clearTimeout(pushTm)
    pushTm = null
    try {
      const rawTs = storage.getItem('gym_last_synced_ts')
      const baseTs = rawTs && !Number.isNaN(Number(rawTs)) ? Number(rawTs) : undefined
      const S = getState().S
      const body = { state: S }
      if (baseTs !== undefined) body.baseTs = baseTs
      const res = await api('/api/data', { method: 'PUT', body: JSON.stringify(body) })
      storage.setItem('gym_last_synced_ts', String(res?.ts || S?._ts || ''))
      storage.removeItem('gym_dirty')
      if (isMobile()) nativeSaveFn?.(S)
      return res
    } catch (e) {
      storage.setItem('gym_dirty', '1')
      if (e.status === 409 || e.statusCode === 409) {
        const serverState = e.serverState || e.state || e.data?.state || e.data?.serverState
        onConflict?.({
          serverState,
          resolveConflict: (choice, sState) => resolveConflict(choice, sState !== undefined ? sState : serverState)
        })
      } else if (e.status === 401 || e.statusCode === 401) {
        setState?.({ sessionExpired: true, reAuthNeeded: true })
      }
    }
  }

  const pullState = async (prefetchedState) => {
    try {
      const state = prefetchedState !== undefined ? prefetchedState : (await api('/api/data'))?.state
      const S = getState().S
      const dirty = storage.getItem('gym_dirty') === '1'
      if (state && dirty && (state._ts || 0) > (S?._ts || 0)) {
        onConflict?.({
          serverState: state,
          resolveConflict: (choice, sState) => resolveConflict(choice, sState !== undefined ? sState : state)
        })
      } else if (state && (!hasData(S) || ((state._ts || 0) >= (S?._ts || 0) && !dirty))) {
        const active = S?.active
        const next = Object.assign(clone(def), state)
        if (active) next.active = active
        persist(next, false)
        if (state._ts) storage.setItem('gym_last_synced_ts', String(state._ts))
      } else if (hasData(S)) {
        await pushState()
      }
      return state
    } catch (e) {
      if (e.status === 401 || e.statusCode === 401) {
        setState?.({ sessionExpired: true, reAuthNeeded: true })
      }
      /* offline — keep local */
    }
  }

  const handleResume = async () => {
    if (!isServerMode()) return
    await pullState()
  }

  const handleOnline = async () => {
    if (!isServerMode()) return
    const dirty = storage.getItem('gym_dirty') === '1'
    if (dirty) {
      await pushState()
    } else {
      await pullState()
    }
  }

  const reconcileOnRegister = async (choice, serverData) => {
    const S = getState().S
    const phoneHasData = hasData(S)
    if (!phoneHasData) {
      await pullState(serverData)
      return
    }

    const c = typeof choice === 'string' ? choice.toLowerCase() : choice
    if (c === 'upload' || c === true) {
      await pushState()
      return
    }

    if (c === 'decline' || c === 'fresh' || c === false) {
      createLocalBackupFn?.(S)
      let serverState = serverData
      if (serverState === undefined) {
        try {
          const res = await api('/api/data')
          serverState = res?.state ?? null
        } catch (e) {
          serverState = null
        }
      }
      const next = Object.assign(clone(def), serverState || {})
      if (getState().replaceState) {
        getState().replaceState(next, false)
      } else {
        persist(next, false)
      }
      if (serverState?._ts) storage.setItem('gym_last_synced_ts', String(serverState._ts))
      else storage.removeItem('gym_last_synced_ts')
      storage.removeItem('gym_dirty')
      if (isMobile()) nativeSaveFn?.(getState().S)
      return
    }

    onRegisterImport?.({
      onChoice: async userChoice => {
        await reconcileOnRegister(userChoice, serverData)
      }
    })
  }

  const reconcileOnConnect = async (serverData) => {
    let serverState = serverData
    if (serverState === undefined) {
      try {
        const res = await api('/api/data')
        serverState = res?.state ?? null
      } catch (e) {
        return
      }
    }

    const S = getState().S
    const phoneHasData = hasData(S)
    const serverHasData = hasData(serverState)

    if (phoneHasData && serverHasData) {
      createLocalBackupFn?.(S)
      onConflict?.({
        serverState,
        resolveConflict: (choice, sState) => resolveConflict(choice, sState !== undefined ? sState : serverState)
      })
    } else if (!phoneHasData && serverHasData) {
      await pullState(serverState)
      if ((getState().S?.cardioActivities?.length || getState().S?.routes?.length)) {
        reconcileTracksAndRoutes?.().catch?.(() => {})
      }
    } else if (phoneHasData && !serverHasData) {
      await pushState()
      if ((getState().S?.cardioActivities?.length || getState().S?.routes?.length)) {
        reconcileTracksAndRoutes?.().catch?.(() => {})
      }
    }
  }

  const handleReauth = async (newUser, serverData) => {
    const prevUser = getState().user
    const isSame = Boolean(prevUser?.id && newUser?.id && prevUser.id === newUser.id)

    if (isSame) {
      if (getState().setUser) getState().setUser(newUser)
      else setState?.({ user: newUser })
      const dirty = storage.getItem('gym_dirty') === '1'
      if (dirty) {
        await pushState()
      }
    } else {
      createLocalBackupFn?.(getState().S)
      storage.removeItem('gym_dirty')
      storage.removeItem('gym_last_synced_ts')
      if (getState().setUser) getState().setUser(newUser)
      else setState?.({ user: newUser })
      await reconcileOnConnect(serverData)
    }
  }

  const disconnectServer = async (opts = {}) => {
    const removeData = typeof opts === 'boolean' ? opts : Boolean(opts?.removeData || opts?.removeServerData)
    clearTimeout(pushTm)
    pushTm = null
    await clearTokenFn?.().catch?.(() => {})
    clearServerConfigFn?.()
    if (getState().setUser) getState().setUser(null)
    else setState?.({ user: null })
    if (getState().setGuest) getState().setGuest(true)
    storage.removeItem('gym_dirty')
    storage.removeItem('gym_last_synced_ts')
    if (removeData) {
      persist(clone(def), false)
      await cleanupCachedServerTracks?.({ adapter: getCardioAdapter?.(), all: true })?.catch?.(() => {})
    } else {
      if (isMobile()) {
        nativeSaveFn?.(getState().S)
      }
    }
  }

  const resolveConflict = async (choice, serverState) => {
    const c = (choice || '').toLowerCase()
    if (c === 'server') {
      createLocalBackupFn?.(getState().S)
      if (serverState) {
        const active = getState().S?.active
        const next = Object.assign(clone(def), serverState)
        if (active) next.active = active
        if (getState().replaceState) {
          getState().replaceState(next, false)
        } else {
          persist(next, false)
        }
        if (serverState._ts) storage.setItem('gym_last_synced_ts', String(serverState._ts))
      }
      storage.removeItem('gym_dirty')
    } else if (c === 'device') {
      await pushState()
    }
  }

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') return
    if (isMobile() && saveTm) {
      clearTimeout(saveTm)
      saveTm = null
      nativeSaveFn?.(getState().S)
    }
    if (pushTm) {
      clearTimeout(pushTm)
      pushTm = null
      return pushState()
    }
  }

  const onOnline = () => handleOnline()

  const onResume = () => handleResume()

  if (attachListeners) {
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', onOnline)
    }
    try {
      CapApp?.addListener?.('resume', onResume)?.catch?.(() => {})
    } catch (e) { /* ignore */ }
  }

  const destroy = () => {
    clearTimeout(pushTm)
    pushTm = null
    clearTimeout(saveTm)
    saveTm = null
    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('online', onOnline)
    }
  }

  return {
    persist,
    flushPending,
    pushState,
    pullState,
    handleResume,
    handleOnline,
    reconcileOnRegister,
    reconcileOnConnect,
    handleReauth,
    disconnectServer,
    resolveConflict,
    destroy
  }
}
