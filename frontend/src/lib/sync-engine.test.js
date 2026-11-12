import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSyncEngine, hasData } from './sync-engine.js'

function createMockStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: vi.fn(k => map.get(k) ?? null),
    setItem: vi.fn((k, v) => { map.set(k, String(v)) }),
    removeItem: vi.fn(k => { map.delete(k) }),
    clear: vi.fn(() => map.clear()),
    _map: map
  }
}

describe('sync-engine', () => {
  let storage
  let state
  let getState
  let setState
  let mockApi
  let onConflict
  let onRegisterImport
  let createLocalBackup

  beforeEach(() => {
    storage = createMockStorage()
    state = {
      S: { _ts: 1000, workouts: [{ id: 'w1', name: 'Bench' }] },
      user: { id: 'u1', name: 'Alice' },
      sessionExpired: false,
      reAuthNeeded: false,
      isServerMode: () => true
    }
    getState = vi.fn(() => state)
    setState = vi.fn(partial => {
      Object.assign(state, partial)
    })
    mockApi = vi.fn()
    onConflict = vi.fn()
    onRegisterImport = vi.fn()
    createLocalBackup = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('hasData helper', () => {
    it('returns false for empty or null state', () => {
      expect(hasData(null)).toBe(false)
      expect(hasData({})).toBe(false)
      expect(hasData({ workouts: [], routines: [], bodyweight: [], cardioActivities: [], gear: [] })).toBe(false)
    })

    it('returns true when any collection has items', () => {
      expect(hasData({ workouts: [{ id: 'w1' }] })).toBe(true)
      expect(hasData({ routines: [{ id: 'r1' }] })).toBe(true)
      expect(hasData({ bodyweight: [{ w: 80 }] })).toBe(true)
      expect(hasData({ cardioActivities: [{ id: 'c1' }] })).toBe(true)
      expect(hasData({ gear: [{ id: 'g1' }] })).toBe(true)
    })
  })

  describe('debounced persistence', () => {
    it('debounces pushState by configured debounceMs and coalesces multiple calls', async () => {
      vi.useFakeTimers()
      mockApi.mockResolvedValue({ ts: 2000 })

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        debounceMs: 1500,
        attachListeners: false
      })

      // First persist call
      engine.persist({ ...state.S, workouts: [{ id: 'w1' }] })
      expect(storage.setItem).toHaveBeenCalledWith('gym_state_v1', expect.any(String))
      expect(mockApi).not.toHaveBeenCalled()

      // Advance by 1000ms (not yet 1500ms)
      vi.advanceTimersByTime(1000)
      expect(mockApi).not.toHaveBeenCalled()

      // Second persist call within debounce window resets timer
      engine.persist({ ...state.S, workouts: [{ id: 'w1' }, { id: 'w2' }] })
      vi.advanceTimersByTime(1000)
      expect(mockApi).not.toHaveBeenCalled()

      // Advance past remaining debounce time
      vi.advanceTimersByTime(500)
      await Promise.resolve()

      expect(mockApi).toHaveBeenCalledTimes(1)
      expect(mockApi).toHaveBeenCalledWith('/api/data', expect.objectContaining({
        method: 'PUT'
      }))
      engine.destroy()
    })

    it('push=false persists locally without triggering debounced push', () => {
      vi.useFakeTimers()
      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        debounceMs: 1500,
        attachListeners: false
      })

      engine.persist({ ...state.S }, false)
      expect(storage.setItem).toHaveBeenCalledWith('gym_state_v1', expect.any(String))

      vi.advanceTimersByTime(3000)
      expect(mockApi).not.toHaveBeenCalled()
      engine.destroy()
    })

    it('flushPending immediately executes and clears pending debounced pushState', async () => {
      vi.useFakeTimers()
      mockApi.mockResolvedValue({ ts: 2000 })

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        debounceMs: 1500,
        attachListeners: false
      })

      engine.persist({ ...state.S })
      expect(mockApi).not.toHaveBeenCalled()

      const flushPromise = engine.flushPending()
      await flushPromise
      expect(mockApi).toHaveBeenCalledTimes(1)

      // Advancing timer further should not trigger another push
      vi.advanceTimersByTime(2000)
      expect(mockApi).toHaveBeenCalledTimes(1)
      engine.destroy()
    })
  })

  describe('pushState 409 conflict callback invocation', () => {
    it('sets gym_dirty and invokes onConflict callback with serverState and resolveConflict', async () => {
      const serverState = { _ts: 5000, workouts: [{ id: 'srv1', name: 'Server Squat' }] }
      const err = new Error('Conflict')
      err.status = 409
      err.serverState = serverState
      mockApi.mockRejectedValue(err)

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        onConflict,
        attachListeners: false
      })

      await engine.pushState()

      expect(storage.setItem).toHaveBeenCalledWith('gym_dirty', '1')
      expect(onConflict).toHaveBeenCalledTimes(1)
      expect(onConflict).toHaveBeenCalledWith({
        serverState,
        resolveConflict: expect.any(Function)
      })

      engine.destroy()
    })
  })

  describe('401 session expiry', () => {
    it('pushState 401 sets sessionExpired, reAuthNeeded and marks dirty', async () => {
      const err = new Error('Unauthorized')
      err.status = 401
      mockApi.mockRejectedValue(err)

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        attachListeners: false
      })

      await engine.pushState()

      expect(storage.setItem).toHaveBeenCalledWith('gym_dirty', '1')
      expect(setState).toHaveBeenCalledWith({ sessionExpired: true, reAuthNeeded: true })
      engine.destroy()
    })

    it('pullState 401 sets sessionExpired and reAuthNeeded', async () => {
      const err = new Error('Unauthorized')
      err.status = 401
      mockApi.mockRejectedValue(err)

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        attachListeners: false
      })

      await engine.pullState()

      expect(setState).toHaveBeenCalledWith({ sessionExpired: true, reAuthNeeded: true })
      engine.destroy()
    })
  })

  describe('pullState dirty reconciliation', () => {
    it('invokes onConflict when gym_dirty is set and server has newer timestamp', async () => {
      storage.setItem('gym_dirty', '1')
      state.S._ts = 1000
      const serverState = { _ts: 2000, workouts: [{ id: 'srv1' }] }
      mockApi.mockResolvedValue({ state: serverState })

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        onConflict,
        attachListeners: false
      })

      await engine.pullState()

      expect(onConflict).toHaveBeenCalledTimes(1)
      expect(onConflict).toHaveBeenCalledWith({
        serverState,
        resolveConflict: expect.any(Function)
      })
      engine.destroy()
    })

    it('adopts server state and preserves active workout when not dirty and server is newer/equal', async () => {
      storage.removeItem('gym_dirty')
      state.S = {
        _ts: 1000,
        workouts: [{ id: 'w1' }],
        active: { routineId: 'r-in-progress', startedAt: 12345 }
      }
      const serverState = {
        _ts: 2000,
        workouts: [{ id: 'srv1', name: 'Server Pull' }]
      }
      mockApi.mockResolvedValue({ state: serverState })

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        onConflict,
        attachListeners: false
      })

      await engine.pullState()

      expect(onConflict).not.toHaveBeenCalled()
      // Active workout preserved in merged state
      expect(state.S.active).toEqual({ routineId: 'r-in-progress', startedAt: 12345 })
      expect(state.S.workouts).toEqual([{ id: 'srv1', name: 'Server Pull' }])
      expect(storage.setItem).toHaveBeenCalledWith('gym_last_synced_ts', '2000')
      engine.destroy()
    })

    it('pushes local state when local has data and server state is older', async () => {
      storage.removeItem('gym_dirty')
      state.S = { _ts: 5000, workouts: [{ id: 'local1' }] }
      const serverState = { _ts: 1000, workouts: [] }
      mockApi.mockImplementation(async (path, opts) => {
        if (opts?.method === 'PUT') return { ts: 5000 }
        return { state: serverState }
      })

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        onConflict,
        attachListeners: false
      })

      await engine.pullState()

      expect(mockApi).toHaveBeenCalledWith('/api/data', expect.objectContaining({
        method: 'PUT'
      }))
      engine.destroy()
    })
  })

  describe('resolveConflict without UI', () => {
    it('choice="server" backs up local data, applies server state, updates ts, and clears dirty', async () => {
      storage.setItem('gym_dirty', '1')
      state.S = {
        _ts: 1000,
        workouts: [{ id: 'local-w1' }],
        active: { routineId: 'active-session' }
      }
      const serverState = {
        _ts: 9999,
        workouts: [{ id: 'srv-w1', name: 'Server Master' }]
      }

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        createLocalBackup,
        attachListeners: false
      })

      await engine.resolveConflict('server', serverState)

      expect(createLocalBackup).toHaveBeenCalledWith(expect.objectContaining({
        workouts: [{ id: 'local-w1' }]
      }))
      expect(state.S.workouts).toEqual([{ id: 'srv-w1', name: 'Server Master' }])
      expect(state.S.active).toEqual({ routineId: 'active-session' })
      expect(storage.getItem('gym_dirty')).toBeNull()
      expect(storage.setItem).toHaveBeenCalledWith('gym_last_synced_ts', '9999')
      engine.destroy()
    })

    it('choice="device" calls pushState to overwrite server with local data', async () => {
      storage.setItem('gym_dirty', '1')
      mockApi.mockResolvedValue({ ts: 1234 })

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        attachListeners: false
      })

      await engine.resolveConflict('device')

      expect(mockApi).toHaveBeenCalledWith('/api/data', expect.objectContaining({
        method: 'PUT'
      }))
      expect(storage.getItem('gym_dirty')).toBeNull()
      engine.destroy()
    })

    it('onConflict injected callback allows headless resolution without passing serverState again', async () => {
      const serverState = { _ts: 8888, workouts: [{ id: 'conflict-w' }] }
      const err = new Error('409')
      err.status = 409
      err.serverState = serverState
      mockApi.mockRejectedValueOnce(err)

      let capturedResolveConflict = null
      const onConflictMock = vi.fn(({ serverState: s, resolveConflict }) => {
        capturedResolveConflict = resolveConflict
      })

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        onConflict: onConflictMock,
        createLocalBackup,
        attachListeners: false
      })

      await engine.pushState()

      expect(onConflictMock).toHaveBeenCalled()
      expect(typeof capturedResolveConflict).toBe('function')

      // Resolve headless with 'server' choice
      await capturedResolveConflict('server')

      expect(createLocalBackup).toHaveBeenCalled()
      expect(state.S.workouts).toEqual([{ id: 'conflict-w' }])
      expect(storage.getItem('gym_dirty')).toBeNull()
      engine.destroy()
    })
  })
})
