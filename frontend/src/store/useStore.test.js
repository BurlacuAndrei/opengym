import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api, setTransport, resetTransport } from '../lib/api.js'

let mockMobile = false
let mockNativeLoad = vi.fn()
let mockNativeSave = vi.fn()
let mockSyncReminder = vi.fn()

vi.mock('../lib/mobile.js', () => ({
  get MOBILE() { return mockMobile },
  nativeLoad: (...args) => mockNativeLoad(...args),
  nativeSave: (...args) => mockNativeSave(...args),
  syncReminder: (...args) => mockSyncReminder(...args),
}))

function createLocalStorage(initial = {}) {
  let store = { ...initial }
  return {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store }
  }
}

describe('api transport seam', () => {
  afterEach(() => {
    resetTransport()
  })

  it('routes api() through swappable transport when set', async () => {
    const mockTransport = vi.fn().mockResolvedValue({ ok: true, data: 'transport-hit' })
    setTransport(mockTransport)

    const res = await api('/api/test', { method: 'POST', body: '{"a":1}' })
    expect(res).toEqual({ ok: true, data: 'transport-hit' })
    expect(mockTransport).toHaveBeenCalledWith('/api/test', { method: 'POST', body: '{"a":1}' })
  })

  it('resets transport back to fetch default with resetTransport', async () => {
    const mockTransport = vi.fn().mockResolvedValue({ ok: true })
    setTransport(mockTransport)
    resetTransport()

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ fromFetch: true })
    })
    const res = await api('/api/direct')
    expect(res).toEqual({ fromFetch: true })
    expect(mockTransport).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('attaches error data and state on HTTP failure', async () => {
    resetTransport()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'conflict', state: { _ts: 123 } })
    })
    try {
      await api('/api/data', { method: 'PUT' })
      expect.fail('should throw')
    } catch (e) {
      expect(e.status).toBe(409)
      expect(e.data).toEqual({ error: 'conflict', state: { _ts: 123 } })
      expect(e.state).toEqual({ _ts: 123 })
      expect(e.serverState).toEqual({ _ts: 123 })
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('useStore', () => {
  let storage
  let useStore
  let setTransport
  let resetTransport

  beforeEach(async () => {
    mockMobile = false
    mockNativeLoad.mockReset()
    mockNativeSave.mockReset()
    mockSyncReminder.mockReset()

    storage = createLocalStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true
    })

    vi.resetModules()
    const apiMod = await import('../lib/api.js')
    setTransport = apiMod.setTransport
    resetTransport = apiMod.resetTransport
    resetTransport()

    const mod = await import('./useStore.js')
    useStore = mod.useStore
  })

  afterEach(() => {
    resetTransport()
  })

  describe('guest mode & user session', () => {
    it('isGuest reflects gym_guest in localStorage', () => {
      const store = useStore.getState()
      expect(store.isGuest()).toBe(false)

      store.setGuest(true)
      expect(storage.setItem).toHaveBeenCalledWith('gym_guest', '1')
      expect(store.isGuest()).toBe(true)

      store.setGuest(false)
      expect(storage.removeItem).toHaveBeenCalledWith('gym_guest')
      expect(store.isGuest()).toBe(false)
    })

    it('setUser saves user and clears guest mode', () => {
      const store = useStore.getState()
      store.setGuest(true)

      store.setUser({ id: 'u1', name: 'Alice' })
      expect(useStore.getState().user).toEqual({ id: 'u1', name: 'Alice' })
      expect(storage.setItem).toHaveBeenCalledWith('gym_user', JSON.stringify({ id: 'u1', name: 'Alice' }))
      expect(storage.removeItem).toHaveBeenCalledWith('gym_guest')
      expect(store.isGuest()).toBe(false)

      store.setUser(null)
      expect(useStore.getState().user).toBeNull()
      expect(storage.removeItem).toHaveBeenCalledWith('gym_user')
    })

    it('signOut clears local session, dirty flags, and resets state', async () => {
      const transport = vi.fn().mockResolvedValue({})
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      storage.setItem('gym_dirty', '1')
      storage.setItem('gym_guest', '1')

      await store.signOut()

      expect(useStore.getState().user).toBeNull()
      expect(storage.removeItem).toHaveBeenCalledWith('gym_user')
      expect(storage.removeItem).toHaveBeenCalledWith('gym_guest')
      expect(storage.removeItem).toHaveBeenCalledWith('gym_dirty')
      expect(storage.removeItem).toHaveBeenCalledWith('gym_last_synced_ts')
      expect(storage.removeItem).toHaveBeenCalledWith('gym_state_v1')
      expect(transport).toHaveBeenCalledWith('/api/logout', expect.objectContaining({ method: 'POST' }))
    })
  })

  describe('web pushState and pullState with timestamp & gym_dirty', () => {
    it('pushState does nothing when no user is signed in', async () => {
      const transport = vi.fn().mockResolvedValue({})
      setTransport(transport)

      const store = useStore.getState()
      expect(store.user).toBeNull()
      await store.pushState()

      expect(transport).not.toHaveBeenCalled()
    })

    it('pushState sends state and removes gym_dirty on success', async () => {
      const transport = vi.fn().mockResolvedValue({ ok: true })
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      storage.setItem('gym_dirty', '1')

      await store.pushState()

      expect(transport).toHaveBeenCalledWith('/api/data', {
        method: 'PUT',
        body: JSON.stringify({ state: store.S })
      })
      expect(storage.removeItem).toHaveBeenCalledWith('gym_dirty')
      expect(storage.getItem('gym_dirty')).toBeNull()
    })

    it('pushState sends baseTs when gym_last_synced_ts is present and tracks updated _ts on success', async () => {
      const transport = vi.fn().mockResolvedValue({ ok: true, ts: 98765 })
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      storage.setItem('gym_last_synced_ts', '12345')
      storage.setItem('gym_dirty', '1')

      await store.pushState()

      expect(transport).toHaveBeenCalledWith('/api/data', {
        method: 'PUT',
        body: JSON.stringify({ state: store.S, baseTs: 12345 })
      })
      expect(storage.removeItem).toHaveBeenCalledWith('gym_dirty')
      expect(storage.setItem).toHaveBeenCalledWith('gym_last_synced_ts', '98765')
      expect(storage.getItem('gym_last_synced_ts')).toBe('98765')
    })

    it('pushState handles 409 conflict by opening openConflictDialog', async () => {
      const { useUI } = await import('./useUI.js')
      useUI.getState().closeAll()

      const serverState = { _ts: 8888, workouts: [{ id: 'srv-1' }] }
      const err = new Error('conflict')
      err.status = 409
      err.serverState = serverState
      const transport = vi.fn().mockRejectedValue(err)
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })

      await store.pushState()

      expect(storage.setItem).toHaveBeenCalledWith('gym_dirty', '1')
      const sheets = useUI.getState().sheets
      expect(sheets.length).toBe(1)
      expect(sheets[0].kind).toBe('center')
      const element = sheets[0].render(() => {})
      expect(element.props.serverState).toEqual(serverState)
    })

    it('pushState sets gym_dirty on network or transport failure', async () => {
      const transport = vi.fn().mockRejectedValue(new Error('Network error'))
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })

      await store.pushState()

      expect(storage.setItem).toHaveBeenCalledWith('gym_dirty', '1')
      expect(storage.getItem('gym_dirty')).toBe('1')
    })

    it('pullState adopts newer server state when not dirty', async () => {
      const serverState = {
        _ts: Date.now() + 10000,
        workouts: [{ id: 'w1', name: 'Push Day' }]
      }
      setTransport(vi.fn().mockResolvedValue({ state: serverState }))

      const store = useStore.getState()
      await store.pullState()

      expect(useStore.getState().S.workouts).toEqual([{ id: 'w1', name: 'Push Day' }])
      expect(storage.setItem).toHaveBeenCalledWith('gym_last_synced_ts', String(serverState._ts))
    })

    it('pullState preserves in-progress active workout when adopting server state', async () => {
      const store = useStore.getState()
      const activeWorkout = { id: 'act1', name: 'Legs in progress' }
      store.update(s => { s.active = activeWorkout }, false)

      const serverState = {
        _ts: Date.now() + 10000,
        workouts: [{ id: 'w1' }],
        active: null
      }
      setTransport(vi.fn().mockResolvedValue({ state: serverState }))

      await store.pullState()

      expect(useStore.getState().S.active).toEqual(activeWorkout)
      expect(useStore.getState().S.workouts).toEqual([{ id: 'w1' }])
    })

    it('pullState pushes local state when local has data and server is older', async () => {
      const transport = vi.fn()
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      // Local state with data and timestamp
      const localTs = 5000
      store.update(s => {
        s._ts = localTs
        s.workouts = [{ id: 'local-w' }]
      }, false)

      // Server returns older state
      transport.mockImplementation(async (path, opts) => {
        if (path === '/api/data' && (!opts || opts.method !== 'PUT')) {
          return { state: { _ts: 2000, workouts: [{ id: 'server-w' }] } }
        }
        return { ok: true }
      })

      await store.pullState()

      // Local state was kept
      expect(useStore.getState().S.workouts).toEqual([{ id: 'local-w' }])
      // Push was triggered
      expect(transport).toHaveBeenCalledWith('/api/data', expect.objectContaining({ method: 'PUT' }))
    })

    it('pullState pushes local changes when gym_dirty is set and server is older', async () => {
      const transport = vi.fn()
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      store.update(s => {
        s.workouts = [{ id: 'dirty-local' }]
      }, false)
      const localTs = store.S._ts
      storage.setItem('gym_dirty', '1')

      // Server returns older state
      transport.mockImplementation(async (path, opts) => {
        if (path === '/api/data' && (!opts || opts.method !== 'PUT')) {
          return { state: { _ts: localTs - 5000, workouts: [{ id: 'server-older' }] } }
        }
        return { ok: true }
      })

      await store.pullState()

      // Should keep local state, not overwrite with server
      expect(useStore.getState().S.workouts).toEqual([{ id: 'dirty-local' }])
      // Should push dirty local changes
      expect(transport).toHaveBeenCalledWith('/api/data', expect.objectContaining({ method: 'PUT' }))
    })

    it('pullState opens openConflictDialog when gym_dirty is set and server state has newer _ts', async () => {
      const { useUI } = await import('./useUI.js')
      useUI.getState().closeAll()

      const transport = vi.fn()
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      store.update(s => {
        s.workouts = [{ id: 'dirty-local' }]
      }, false)
      const localTs = useStore.getState().S._ts
      storage.setItem('gym_dirty', '1')

      const serverState = { _ts: localTs + 5000, workouts: [{ id: 'server-newer' }] }
      transport.mockResolvedValue({ state: serverState })

      await store.pullState()

      // Should keep local state, not overwrite with server
      expect(useStore.getState().S.workouts).toEqual([{ id: 'dirty-local' }])
      // Should NOT have pushed to server
      expect(transport).not.toHaveBeenCalledWith('/api/data', expect.objectContaining({ method: 'PUT' }))
      // Should open conflict dialog
      const sheets = useUI.getState().sheets
      expect(sheets.length).toBe(1)
      expect(sheets[0].kind).toBe('center')
      const element = sheets[0].render(() => {})
      expect(element.props.serverState).toEqual(serverState)
    })

    it('pullState silently retains local state when offline/api fails', async () => {
      setTransport(vi.fn().mockRejectedValue(new Error('Failed to fetch')))

      const store = useStore.getState()
      store.update(s => { s.workouts = [{ id: 'local-persists' }] }, false)

      await expect(store.pullState()).resolves.toBeUndefined()
      expect(useStore.getState().S.workouts).toEqual([{ id: 'local-persists' }])
    })
  })

  describe('mobile boot native mirror', () => {
    it('restores from nativeLoad when saved mirror is newer than local S', async () => {
      mockMobile = true
      const savedState = {
        _ts: 50000,
        workouts: [{ id: 'native-1', name: 'Restored from mirror' }]
      }
      mockNativeLoad.mockResolvedValue(savedState)

      const store = useStore.getState()
      await store.boot()

      expect(mockNativeLoad).toHaveBeenCalled()
      expect(useStore.getState().S.workouts).toEqual([{ id: 'native-1', name: 'Restored from mirror' }])
      expect(store.isGuest()).toBe(true)
      expect(mockSyncReminder).toHaveBeenCalledWith(useStore.getState().S)
      expect(useStore.getState().ready).toBe(true)
    })

    it('seeds the native mirror if local has data and nativeLoad has older or no data', async () => {
      mockMobile = true
      mockNativeLoad.mockResolvedValue(null)

      const store = useStore.getState()
      store.update(s => {
        s.workouts = [{ id: 'existing-local' }]
        s._ts = 10000
      }, false)

      await store.boot()

      expect(mockNativeLoad).toHaveBeenCalled()
      expect(mockNativeSave).toHaveBeenCalledWith(useStore.getState().S)
      expect(store.isGuest()).toBe(true)
      expect(useStore.getState().ready).toBe(true)
    })

    it('bypasses web /api/config and /api/me calls entirely on mobile boot', async () => {
      mockMobile = true
      mockNativeLoad.mockResolvedValue(null)
      const transport = vi.fn()
      setTransport(transport)

      const store = useStore.getState()
      await store.boot()

      expect(transport).not.toHaveBeenCalled()
      expect(useStore.getState().ready).toBe(true)
    })
  })

  describe('Android mobile server mode passkey, token persistence, and boot flow', () => {
    it('uses NativePasskey.login, passes native:true to verify, stores token via setToken, sets user and unsets guest', async () => {
      mockMobile = true
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; Pixel 8)')
      storage.setItem('gym_server_config', JSON.stringify({ url: 'https://gym.example.com' }))
      storage.setItem('gym_guest', '1')

      const { passkeyLogin, NativePasskey } = await import('../lib/api.js')
      const { getToken } = await import('../lib/token-storage.js')

      const mockNativeLogin = vi.fn().mockResolvedValue({
        credential: { id: 'native-cred-id', rawId: 'cmF3MQ' }
      })
      NativePasskey.login = mockNativeLogin

      const transportCalls = []
      const transport = vi.fn().mockImplementation(async (path, opts) => {
        transportCalls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null })
        if (path === '/api/login/options') {
          return { cid: 'cid-android-123', options: { challenge: 'test-challenge' } }
        }
        if (path === '/api/login/verify') {
          return {
            user: { id: 'u-android-1', name: 'Android Lifter' },
            token: 'jwt-android-native-token'
          }
        }
        return {}
      })
      setTransport(transport)

      const user = await passkeyLogin()

      expect(mockNativeLogin).toHaveBeenCalledWith({
        options: { challenge: 'test-challenge' }
      })
      expect(transportCalls).toContainEqual({
        path: '/api/login/verify',
        body: {
          cid: 'cid-android-123',
          credential: { id: 'native-cred-id', rawId: 'cmF3MQ' },
          native: true
        }
      })
      expect(user).toEqual({ id: 'u-android-1', name: 'Android Lifter' })
      expect(await getToken()).toBe('jwt-android-native-token')
      expect(useStore.getState().user).toEqual({ id: 'u-android-1', name: 'Android Lifter' })
      expect(useStore.getState().isGuest()).toBe(false)
      expect(storage.getItem('gym_guest')).toBeNull()
      expect(JSON.parse(storage.getItem('gym_user'))).toEqual({ id: 'u-android-1', name: 'Android Lifter' })
    })

    it('boot in server mode keeps cached user without forcing guest mode and pulls server data on empty phone', async () => {
      mockMobile = true
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; Pixel 8)')
      storage.setItem('gym_server_config', JSON.stringify({ url: 'https://gym.example.com' }))
      storage.setItem('gym_user', JSON.stringify({ id: 'cached-u-1', name: 'Cached User' }))
      useStore.getState().setUser({ id: 'cached-u-1', name: 'Cached User' })
      expect(useStore.getState().isGuest()).toBe(false)

      mockNativeLoad.mockResolvedValue(null) // phone empty

      const transport = vi.fn().mockImplementation(async (path) => {
        if (path === '/api/data') {
          return {
            state: {
              _ts: 99999,
              workouts: [{ id: 'server-w1', name: 'Deadlift Day' }],
              routines: [{ id: 'r1', name: 'Pull' }]
            }
          }
        }
        return {}
      })
      setTransport(transport)

      await useStore.getState().boot()

      expect(useStore.getState().isGuest()).toBe(false)
      expect(storage.getItem('gym_guest')).toBeNull()
      expect(useStore.getState().user).toEqual({ id: 'cached-u-1', name: 'Cached User' })
      expect(useStore.getState().S.workouts).toEqual([{ id: 'server-w1', name: 'Deadlift Day' }])
      expect(useStore.getState().S.routines).toEqual([{ id: 'r1', name: 'Pull' }])
      expect(mockSyncReminder).toHaveBeenCalledWith(useStore.getState().S)
      expect(useStore.getState().ready).toBe(true)
    })

    it('handles USER_CANCELLED cleanly without error toast', async () => {
      mockMobile = true
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; Pixel 8)')
      storage.setItem('gym_server_config', JSON.stringify({ url: 'https://gym.example.com' }))

      const { passkeyLogin, NativePasskey } = await import('../lib/api.js')
      const { useUI } = await import('./useUI.js')

      NativePasskey.login = vi.fn().mockRejectedValue({
        message: 'USER_CANCELLED',
        code: 'USER_CANCELLED'
      })

      const transport = vi.fn().mockImplementation(async (path) => {
        if (path === '/api/login/options') {
          return { cid: 'cid-cancel', options: { challenge: 'test-challenge' } }
        }
        return {}
      })
      setTransport(transport)

      const toastSpy = vi.spyOn(useUI.getState(), 'toast')

      // Test passkeyLogin rejections
      await expect(passkeyLogin()).rejects.toThrow('USER_CANCELLED')

      // Simulate sign in flow as in Login.jsx
      try {
        await passkeyLogin()
      } catch (e) {
        const isCancel = e.name === 'NotAllowedError' || e.name === 'AbortError' || e.message === 'USER_CANCELLED' || e.code === 'USER_CANCELLED' || e?.message?.includes?.('USER_CANCELLED')
        if (!isCancel) useUI.getState().toast('Sign-in failed')
      }

      expect(toastSpy).not.toHaveBeenCalled()
    })
  })

  describe('web boot flow', () => {
    it('loads config, user from /api/me, and pulls state on web boot', async () => {
      const transport = vi.fn().mockImplementation(async (path) => {
        if (path === '/api/config') return { coach: { provider: 'openai' } }
        if (path === '/api/me') return { user: { id: 'user-42', name: 'Bob' } }
        if (path === '/api/data') return { state: { _ts: 100, workouts: [] } }
        return {}
      })
      setTransport(transport)

      const store = useStore.getState()
      await store.boot()

      expect(useStore.getState().config).toEqual({ coach: { provider: 'openai' } })
      expect(useStore.getState().user).toEqual({ id: 'user-42', name: 'Bob' })
      expect(useStore.getState().ready).toBe(true)
    })

    it('clears user when /api/me returns 401', async () => {
      const unauthErr = new Error('HTTP 401')
      unauthErr.status = 401

      const transport = vi.fn().mockImplementation(async (path) => {
        if (path === '/api/config') return {}
        if (path === '/api/me') throw unauthErr
        return {}
      })
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'old-user' })

      await store.boot()

      expect(useStore.getState().user).toBeNull()
      expect(useStore.getState().ready).toBe(true)
    })
  })

  describe('conflict resolution & local backup', () => {
    it('creates local backup before replacing on "server" choice and clears gym_dirty', async () => {
      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      store.update(s => {
        s.workouts = [{ id: 'device-workout', name: 'Leg Day' }]
      }, false)
      storage.setItem('gym_dirty', '1')

      const serverState = {
        _ts: 9999,
        workouts: [{ id: 'server-workout', name: 'Upper Body' }]
      }

      await store.resolveConflict('server', serverState)

      // 1. Verify backup was saved to storage before state was overwritten
      expect(storage.setItem).toHaveBeenCalledWith(
        'gym_backup_latest',
        expect.stringContaining('device-workout')
      )
      const latestRaw = storage.getItem('gym_backup_latest')
      expect(latestRaw).toBeTruthy()
      const backupObj = JSON.parse(latestRaw)
      expect(backupObj.state.workouts).toEqual([{ id: 'device-workout', name: 'Leg Day' }])

      // 2. Verify state was replaced with server state
      expect(useStore.getState().S.workouts).toEqual([{ id: 'server-workout', name: 'Upper Body' }])

      // 3. Verify gym_dirty was cleared
      expect(storage.removeItem).toHaveBeenCalledWith('gym_dirty')
    })

    it('preserves in-progress active workout on "server" choice', async () => {
      const store = useStore.getState()
      const activeWorkout = { id: 'act-in-progress', name: 'Chest' }
      store.update(s => {
        s.active = activeWorkout
        s.workouts = [{ id: 'old-w' }]
      }, false)

      const serverState = {
        _ts: 8888,
        workouts: [{ id: 'server-w' }],
        active: null
      }

      await store.resolveConflict('server', serverState)

      expect(useStore.getState().S.active).toEqual(activeWorkout)
      expect(useStore.getState().S.workouts).toEqual([{ id: 'server-w' }])
    })

    it('pushes local state on "device" choice', async () => {
      const transport = vi.fn().mockResolvedValue({ ok: true })
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      store.update(s => {
        s.workouts = [{ id: 'device-w', name: 'Arms' }]
      }, false)
      storage.setItem('gym_dirty', '1')

      const serverState = {
        _ts: 5555,
        workouts: [{ id: 'server-w', name: 'Cardio' }]
      }

      await store.resolveConflict('device', serverState)

      // Pushed local state to server
      expect(transport).toHaveBeenCalledWith('/api/data', {
        method: 'PUT',
        body: JSON.stringify({ state: useStore.getState().S })
      })

      // Retained local state
      expect(useStore.getState().S.workouts).toEqual([{ id: 'device-w', name: 'Arms' }])
      // Removed dirty flag
      expect(storage.removeItem).toHaveBeenCalledWith('gym_dirty')
    })

    it('handles backup library createLocalBackup, getLatestBackup, and restoreLocalBackup', async () => {
      const { createLocalBackup, getLatestBackup, restoreLocalBackup } = await import('../lib/backup.js')

      const sampleState = {
        unit: 'kg',
        workouts: [{ id: 'b1', name: 'Bench' }]
      }

      const backup = createLocalBackup(sampleState, 1234567890)
      expect(backup).toBeTruthy()
      expect(backup.key).toBe('gym_backup_1234567890')
      expect(backup.state.workouts).toEqual(sampleState.workouts)

      const latest = getLatestBackup()
      expect(latest).toBeTruthy()
      expect(latest.timestamp).toBe(1234567890)

      const restored = restoreLocalBackup(backup.key)
      expect(restored.workouts).toEqual(sampleState.workouts)
    })

    it('openConflictDialog opens sheet and resolves with chosen option', async () => {
      const { useUI } = await import('./useUI.js')
      const { openConflictDialog } = await import('../components/ConflictDialog.jsx')

      useUI.getState().closeAll()
      expect(useUI.getState().sheets.length).toBe(0)

      const serverState = { _ts: 1234, workouts: [{ id: 'srv-w' }] }
      let resolved = false
      const promise = openConflictDialog({ serverState, autoResolve: false })
      promise.then(choice => {
        expect(choice).toBe('device')
        resolved = true
      })

      const sheets = useUI.getState().sheets
      expect(sheets.length).toBe(1)
      expect(sheets[0].kind).toBe('center')

      // Render the sheet to access the onResolve prop
      const element = sheets[0].render(() => useUI.getState().closeSheet(sheets[0].id))
      expect(element.props.serverState).toEqual(serverState)

      // Simulate choosing "device"
      await element.props.onResolve('device')
      expect(resolved).toBe(true)
      expect(useUI.getState().sheets.length).toBe(0)
    })
  })
})
