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

  describe('mobile nativeSave single-flight coalescing & lifecycle (Issue #7)', () => {
    it('writes nativeSave at 0ms on persist() while keeping syncReminder debounced at 800ms', async () => {
      vi.useFakeTimers()
      const nativeSave = vi.fn().mockResolvedValue(undefined)
      const syncReminder = vi.fn()

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        mobile: true,
        nativeSave,
        syncReminder,
        attachListeners: false
      })

      engine.persist({ _ts: 1, workouts: [{ id: 'w1' }] }, false)
      expect(nativeSave).toHaveBeenCalledTimes(1)
      expect(nativeSave).toHaveBeenCalledWith(expect.objectContaining({ workouts: [{ id: 'w1' }] }))
      expect(syncReminder).not.toHaveBeenCalled()

      vi.advanceTimersByTime(799)
      expect(syncReminder).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(syncReminder).toHaveBeenCalledTimes(1)
      engine.destroy()
    })

    it('coalesces burst persist() calls via single-flight flushNativeSave and recovers after write error', async () => {
      let rejectFirst
      const firstWrite = new Promise((_, rej) => { rejectFirst = rej })
      let resolveSecond
      const secondWrite = new Promise(res => { resolveSecond = res })
      const nativeSave = vi.fn()
        .mockReturnValueOnce(firstWrite)
        .mockReturnValueOnce(secondWrite)
        .mockResolvedValue(undefined)

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        mobile: true,
        nativeSave,
        syncReminder: vi.fn(),
        attachListeners: false
      })

      engine.persist({ _ts: 1, workouts: [{ id: 'w1' }] }, false)
      expect(nativeSave).toHaveBeenCalledTimes(1)

      // Burst of rapid edits while first write is still in-flight
      engine.persist({ _ts: 2, workouts: [{ id: 'w1' }, { id: 'w2' }] }, false)
      engine.persist({ _ts: 3, workouts: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] }, false)
      engine.persist({ _ts: 4, workouts: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }] }, false)
      expect(nativeSave).toHaveBeenCalledTimes(1)

      // Even if first write fails, coalescer drains the latest dirty state once
      rejectFirst(new Error('disk full'))
      await Promise.resolve()
      await Promise.resolve()

      expect(nativeSave).toHaveBeenCalledTimes(2)
      expect(nativeSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ workouts: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }] })
      )

      resolveSecond()
      await engine.flushPending()

      // Subsequent persist starts a fresh leading-edge write
      engine.persist({ _ts: 5, workouts: [{ id: 'w5' }] }, false)
      expect(nativeSave).toHaveBeenCalledTimes(3)
      engine.destroy()
    })

    it('flushPending flushes reminderTm, pushTm, and awaits in-flight nativeSave without extra write', async () => {
      vi.useFakeTimers()
      mockApi.mockResolvedValue({ ts: 9000 })
      let resolveSave
      const nativeSave = vi.fn()
        .mockImplementationOnce(() => new Promise(res => { resolveSave = res }))
        .mockResolvedValue(undefined)
      const syncReminder = vi.fn()

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        mobile: true,
        nativeSave,
        syncReminder,
        debounceMs: 1500,
        attachListeners: false
      })

      engine.persist({ _ts: 10, workouts: [{ id: 'w-flush' }] }, true)
      expect(nativeSave).toHaveBeenCalledTimes(1)
      expect(syncReminder).not.toHaveBeenCalled()
      expect(mockApi).not.toHaveBeenCalled()

      let flushed = false
      const p = engine.flushPending().then(() => { flushed = true })

      // reminderTm and pushTm execute immediately; promise still awaits in-flight nativeSave
      await Promise.resolve()
      await Promise.resolve()
      expect(syncReminder).toHaveBeenCalledTimes(1)
      expect(mockApi).toHaveBeenCalledTimes(1)
      expect(flushed).toBe(false)

      resolveSave()
      await p
      expect(flushed).toBe(true)
      // Push completion also mirrors through flushNativeSave
      expect(nativeSave).toHaveBeenCalledTimes(2)

      // In guest mode (no push), flushPending awaits in-flight nativeSave without triggering an extra write
      let resolveGuestSave
      nativeSave.mockImplementationOnce(() => new Promise(res => { resolveGuestSave = res }))
      engine.persist({ _ts: 11, workouts: [{ id: 'w-guest' }] }, false)
      expect(nativeSave).toHaveBeenCalledTimes(3)

      let guestFlushed = false
      const gp = engine.flushPending().then(() => { guestFlushed = true })
      await Promise.resolve()
      expect(guestFlushed).toBe(false)

      resolveGuestSave()
      await gp
      expect(guestFlushed).toBe(true)
      expect(nativeSave).toHaveBeenCalledTimes(3)
      engine.destroy()
    })

    it('attaches pagehide, pause, appStateChange(isActive=false), and cleans up capHandles on destroy()', async () => {
      const docListeners = {}
      const winListeners = {}
      const capListeners = {}
      const removeSpy = vi.fn()

      vi.stubGlobal('document', {
        visibilityState: 'hidden',
        addEventListener: vi.fn((ev, cb) => { docListeners[ev] = cb }),
        removeEventListener: vi.fn((ev) => { delete docListeners[ev] }),
      })
      vi.stubGlobal('window', {
        addEventListener: vi.fn((ev, cb) => { winListeners[ev] = cb }),
        removeEventListener: vi.fn((ev) => { delete winListeners[ev] }),
      })

      const capApp = {
        addListener: vi.fn((ev, cb) => {
          capListeners[ev] = cb
          return Promise.resolve({ remove: removeSpy })
        })
      }

      const nativeSave = vi.fn().mockResolvedValue(undefined)
      const syncReminder = vi.fn()
      mockApi.mockResolvedValue({ ts: 5000 })

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        mobile: true,
        nativeSave,
        syncReminder,
        capApp,
        attachListeners: true
      })

      await Promise.resolve()
      expect(capListeners.resume).toBeTypeOf('function')
      expect(capListeners.pause).toBeTypeOf('function')
      expect(capListeners.appStateChange).toBeTypeOf('function')
      expect(winListeners.pagehide).toBeTypeOf('function')

      // appStateChange with isActive: true should NOT flush
      engine.persist({ _ts: 1, workouts: [{ id: 'a1' }] }, true)
      await capListeners.appStateChange({ isActive: true })
      expect(syncReminder).not.toHaveBeenCalled()

      // appStateChange with isActive: false flushes pending reminder + push
      await capListeners.appStateChange({ isActive: false })
      expect(syncReminder).toHaveBeenCalledTimes(1)
      expect(mockApi).toHaveBeenCalledTimes(1)

      // pause and pagehide also trigger flushPending
      engine.persist({ _ts: 2, workouts: [{ id: 'a2' }] }, true)
      await capListeners.pause()
      expect(syncReminder).toHaveBeenCalledTimes(2)

      engine.persist({ _ts: 3, workouts: [{ id: 'a3' }] }, true)
      await winListeners.pagehide()
      expect(syncReminder).toHaveBeenCalledTimes(3)

      // destroy() cleans up capHandles, DOM listeners, and prevents further dirty loops
      engine.destroy()
      expect(removeSpy).toHaveBeenCalledTimes(3)
      expect(docListeners.visibilitychange).toBeUndefined()
      expect(winListeners.online).toBeUndefined()
      expect(winListeners.pagehide).toBeUndefined()

      vi.unstubAllGlobals()
    })

    it('routes disconnectServer and reconcileOnRegister mirror saves through flushNativeSave', async () => {
      let resolveFirst
      const firstWrite = new Promise(res => { resolveFirst = res })
      const nativeSave = vi.fn()
        .mockReturnValueOnce(firstWrite)
        .mockResolvedValue(undefined)

      const engine = createSyncEngine({
        getState,
        setState,
        storage,
        api: mockApi,
        mobile: true,
        nativeSave,
        syncReminder: vi.fn(),
        clearToken: vi.fn().mockResolvedValue(undefined),
        clearServerConfig: vi.fn(),
        attachListeners: false
      })

      // Start an in-flight write, then call disconnectServer({ removeData: false })
      engine.persist({ _ts: 1, workouts: [{ id: 'w1' }] }, false)
      expect(nativeSave).toHaveBeenCalledTimes(1)

      let disconnected = false
      const discPromise = engine.disconnectServer({ removeData: false }).then(() => { disconnected = true })
      await Promise.resolve()
      await Promise.resolve()
      // Still awaiting coalesced write instead of racing a concurrent Filesystem.writeFile
      expect(nativeSave).toHaveBeenCalledTimes(1)
      expect(disconnected).toBe(false)

      resolveFirst()
      await discPromise
      expect(disconnected).toBe(true)
      expect(nativeSave).toHaveBeenCalledTimes(2)

      // reconcileOnRegister('decline') also routes through flushNativeSave
      await engine.reconcileOnRegister('decline', { _ts: 777, workouts: [{ id: 'srv' }] })
      expect(nativeSave).toHaveBeenCalledWith(expect.objectContaining({ workouts: [{ id: 'srv' }] }))
      engine.destroy()
    })

    it('removes pending capApp handles on settlement when destroy() runs early and ignores post-destroy callbacks', async () => {
      const docListeners = {}
      const winListeners = {}
      const capListeners = {}
      const resolvers = []
      const removeSpy = vi.fn()

      vi.stubGlobal('document', {
        visibilityState: 'hidden',
        addEventListener: vi.fn((ev, cb) => { docListeners[ev] = cb }),
        removeEventListener: vi.fn((ev) => { delete docListeners[ev] }),
      })
      vi.stubGlobal('window', {
        addEventListener: vi.fn((ev, cb) => { winListeners[ev] = cb }),
        removeEventListener: vi.fn((ev) => { delete winListeners[ev] }),
      })

      const capApp = {
        addListener: vi.fn((ev, cb) => {
          capListeners[ev] = cb
          return new Promise(resolve => { resolvers.push(resolve) })
        })
      }

      const nativeSave = vi.fn().mockResolvedValue(undefined)
      const syncReminder = vi.fn()

      try {
        const engine = createSyncEngine({
          getState,
          setState,
          storage,
          api: mockApi,
          mobile: true,
          nativeSave,
          syncReminder,
          capApp,
          attachListeners: true
        })

        const onVisibilityChange = docListeners.visibilitychange
        const onPageHide = winListeners.pagehide
        const onOnline = winListeners.online
        expect(onVisibilityChange).toBeTypeOf('function')
        expect(onPageHide).toBeTypeOf('function')
        expect(onOnline).toBeTypeOf('function')

        // Destroy before capApp.addListener promises settle
        engine.destroy()
        expect(removeSpy).not.toHaveBeenCalled()
        expect(docListeners.visibilitychange).toBeUndefined()
        expect(winListeners.pagehide).toBeUndefined()
        expect(winListeners.online).toBeUndefined()

        // Invoking captured listener callbacks after destroy() is a sync no-op
        expect(onVisibilityChange()).toBeUndefined()
        expect(onPageHide()).toBeUndefined()
        expect(onOnline()).toBeUndefined()
        expect(capListeners.pause()).toBeUndefined()
        expect(capListeners.appStateChange({ isActive: false })).toBeUndefined()
        expect(capListeners.resume()).toBeUndefined()
        expect(mockApi).not.toHaveBeenCalled()
        expect(nativeSave).not.toHaveBeenCalled()
        expect(syncReminder).not.toHaveBeenCalled()

        // Resolving addListener promises after destroy() removes each handle on settlement
        resolvers.forEach(resolve => resolve({ remove: removeSpy }))
        await Promise.resolve()
        await Promise.resolve()
        expect(removeSpy).toHaveBeenCalledTimes(3)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('swallows rejected promises and sync throws from handle.remove() with zero unhandled rejections', async () => {
      const unhandled = []
      const onUnhandled = (err) => { unhandled.push(err) }
      process.on('unhandledRejection', onUnhandled)

      try {
        const syncThrowRemove = vi.fn(() => { throw new Error('sync remove failure') })
        const asyncRejectRemove = vi.fn(() => Promise.reject(new Error('async remove failure')))

        // Case 1: handles resolved before destroy()
        const capAppResolved = {
          addListener: vi.fn()
            .mockResolvedValueOnce({ remove: syncThrowRemove })
            .mockResolvedValueOnce({ remove: asyncRejectRemove })
            .mockRejectedValueOnce(new Error('addListener rejected'))
        }

        const engine1 = createSyncEngine({
          getState,
          setState,
          storage,
          api: mockApi,
          mobile: false,
          capApp: capAppResolved,
          attachListeners: true
        })
        await Promise.resolve()
        await Promise.resolve()
        expect(() => engine1.destroy()).not.toThrow()

        // Case 2: handles resolve (or addListener rejects) after destroy()
        const resolvers = []
        const lateSyncThrowRemove = vi.fn(() => { throw new Error('late sync remove failure') })
        const lateAsyncRejectRemove = vi.fn(() => Promise.reject(new Error('late async remove failure')))
        const capAppPending = {
          addListener: vi.fn(() => new Promise((resolve, reject) => {
            resolvers.push({ resolve, reject })
          }))
        }

        const engine2 = createSyncEngine({
          getState,
          setState,
          storage,
          api: mockApi,
          mobile: false,
          capApp: capAppPending,
          attachListeners: true
        })
        engine2.destroy()

        resolvers[0].resolve({ remove: lateSyncThrowRemove })
        resolvers[1].resolve({ remove: lateAsyncRejectRemove })
        resolvers[2].reject(new Error('late addListener rejection'))

        await new Promise(resolve => setTimeout(resolve, 0))

        expect(syncThrowRemove).toHaveBeenCalledTimes(1)
        expect(asyncRejectRemove).toHaveBeenCalledTimes(1)
        expect(lateSyncThrowRemove).toHaveBeenCalledTimes(1)
        expect(lateAsyncRejectRemove).toHaveBeenCalledTimes(1)
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })
  })

  describe('mobile.js filesystem module caching (Issue #7)', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
      vi.doUnmock('@capacitor/filesystem')
      vi.resetModules()
    })

    it('caches @capacitor/filesystem across nativeLoad/nativeSave and resets cache on import failure', async () => {
      vi.stubEnv('VITE_MOBILE', '1')
      const readFile = vi.fn().mockResolvedValue({ data: JSON.stringify({ _ts: 42, workouts: [] }) })
      const writeFile = vi.fn().mockResolvedValue(undefined)

      let loadAttempts = 0
      vi.doMock('@capacitor/filesystem', () => {
        loadAttempts += 1
        if (loadAttempts === 1) throw new Error('transient import error')
        return { Filesystem: { readFile, writeFile }, Directory: { Data: 'DATA' }, Encoding: { UTF8: 'utf8' } }
      })
      vi.resetModules()

      const mobileMod = await import('./mobile.js')
      expect(mobileMod.MOBILE).toBe(true)

      // First call fails to import -> clears fsPromise and falls back cleanly
      expect(await mobileMod.nativeLoad()).toBeNull()
      expect(loadAttempts).toBe(1)

      // Second call retries import, succeeds, and caches fsMod for subsequent calls
      const loaded = await mobileMod.nativeLoad()
      expect(loaded).toEqual({ _ts: 42, workouts: [] })
      expect(loadAttempts).toBe(2)

      await mobileMod.nativeSave({ _ts: 43, workouts: [{ id: 'w1' }] })
      await mobileMod.nativeSave({ _ts: 44, workouts: [{ id: 'w2' }] })
      expect(loadAttempts).toBe(2)
      expect(writeFile).toHaveBeenCalledTimes(2)
    })
  })
})
