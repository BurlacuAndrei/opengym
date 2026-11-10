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

    it('pullState does not overwrite local changes when gym_dirty is set, triggers push instead', async () => {
      const transport = vi.fn()
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      store.update(s => {
        s._ts = 1000
        s.workouts = [{ id: 'dirty-local' }]
      }, false)
      storage.setItem('gym_dirty', '1')

      // Server has higher timestamp, but local is dirty
      transport.mockImplementation(async (path, opts) => {
        if (path === '/api/data' && (!opts || opts.method !== 'PUT')) {
          return { state: { _ts: 9999, workouts: [{ id: 'server-newer' }] } }
        }
        return { ok: true }
      })

      await store.pullState()

      // Should keep local state, not overwrite with server
      expect(useStore.getState().S.workouts).toEqual([{ id: 'dirty-local' }])
      // Should push dirty local changes
      expect(transport).toHaveBeenCalledWith('/api/data', expect.objectContaining({ method: 'PUT' }))
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
})
