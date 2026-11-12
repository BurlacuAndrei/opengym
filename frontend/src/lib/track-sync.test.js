import { describe, it, expect, beforeEach, vi } from 'vitest'

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    get length() {
      return store.size
    },
    key: i => Array.from(store.keys())[i] ?? null
  }
}

import {
  markCachedServerTrack,
  isCachedServerTrack,
  getCachedServerTracks,
  clearCachedServerTracksRegistry,
  getTrackId,
  getRouteId,
  resolveActivityTrackPath,
  resolveRouteTrackPath,
  fetchServerTrackList,
  uploadUnsyncedTracks,
  uploadUnsyncedRoutes,
  reconcileTracksAndRoutes,
  lazyFetchTrack,
  lazyFetchRoute,
  deleteRemoteTrack,
  deleteRemoteRoute,
  pruneRemoteTracks,
  pruneRemoteRoutes,
  propagateTrackDeletion,
  propagateRouteDeletion,
  propagateTrackPrune,
  cleanupCachedServerTracks
} from './track-sync.js'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
  getCardioAdapter
} from './cardio-adapter.js'
import { useStore, DEF } from '../store/useStore.js'
import { setTransport, resetTransport } from './api.js'

describe('Track & Route Sync Subsystem (Issue #80)', () => {
  let memoryAdapter
  let apiCalls

  const createMockTransport = (responses = {}) => {
    return vi.fn(async (path, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase()
      const body = opts.body ? JSON.parse(opts.body) : undefined
      apiCalls.push({ path, method, body, opts })

      if (responses[path]) {
        const resp = responses[path]
        if (typeof resp === 'function') return resp(method, body, opts)
        return resp
      }

      // Pattern matching for routes like /api/tracks/:id, /api/routes/:id
      for (const [pattern, handler] of Object.entries(responses)) {
        if (pattern.includes(':id') || pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(':id', '([^/]+)').replace('*', '.*') + '$')
          const match = path.match(regex)
          if (match) {
            if (typeof handler === 'function') return handler(match[1], method, body, opts)
            return handler
          }
        }
      }

      if (method === 'GET') {
        if (path === '/api/tracks' || path === '/api/routes') {
          return { tracks: [], routes: [] }
        }
        return { ok: true }
      }
      if (method === 'PUT' || method === 'POST' || method === 'DELETE') {
        return { ok: true }
      }
      return { ok: true }
    })
  }

  beforeEach(() => {
    memoryAdapter = createMemoryCardioAdapter()
    setCardioAdapter(memoryAdapter)
    clearCachedServerTracksRegistry()
    apiCalls = []
    resetTransport()
    useStore.setState({
      S: JSON.parse(JSON.stringify(DEF)),
      user: null
    })
    if (typeof localStorage !== 'undefined') {
      localStorage.clear()
    }
  })

  describe('Path and ID Resolution', () => {
    it('extracts track and route IDs from strings and objects', () => {
      expect(getTrackId('2026/track-123.json')).toBe('track-123')
      expect(getTrackId('track-456.json')).toBe('track-456')
      expect(getTrackId({ id: 'track-789' })).toBe('track-789')
      expect(getTrackId(null)).toBe('')

      expect(getRouteId('routes/route-abc.json')).toBe('route-abc')
      expect(getRouteId('route-def.json')).toBe('route-def')
      expect(getRouteId({ id: 'route-ghi' })).toBe('route-ghi')
      expect(getRouteId(null)).toBe('')
    })

    it('resolves track file paths for activities', () => {
      expect(resolveActivityTrackPath('my-track')).toBe('my-track.json')
      expect(resolveActivityTrackPath('2026/my-track.json')).toBe('2026/my-track.json')
      expect(resolveActivityTrackPath({ id: 'act-1', trackPath: '2026/act-1.json' })).toBe('2026/act-1.json')
      expect(resolveActivityTrackPath({ id: 'act-2', startTime: '2026-06-15T10:00:00Z' })).toBe('2026/act-2.json')
      expect(resolveActivityTrackPath({ id: 'act-3' })).toBe('act-3.json')
    })

    it('resolves track file paths for routes', () => {
      expect(resolveRouteTrackPath('r1')).toBe('routes/r1.json')
      expect(resolveRouteTrackPath('routes/r2.json')).toBe('routes/r2.json')
      expect(resolveRouteTrackPath({ id: 'r3', trackPath: 'routes/custom.json' })).toBe('routes/custom.json')
      expect(resolveRouteTrackPath({ id: 'r4' })).toBe('routes/r4.json')
    })
  })

  describe('Server Track List Reconciliation & Background Upload', () => {
    it('fetchServerTrackList queries GET /api/tracks and normalizes track & route lists', async () => {
      const transport = createMockTransport({
        '/api/tracks': { tracks: ['t1', 't2'], routes: ['r1'] }
      })

      const list = await fetchServerTrackList({ api: transport })
      expect(list.tracks).toEqual(['t1', 't2'])
      expect(list.routes).toEqual(['r1'])
      expect(transport).toHaveBeenCalledWith('/api/tracks', { method: 'GET' })
    })

    it('fetchServerTrackList handles alternative server field names (trackIds, routeIds)', async () => {
      const transport = createMockTransport({
        '/api/tracks': { trackIds: ['tid-1'], routeIds: ['rid-1'] }
      })

      const list = await fetchServerTrackList({ api: transport })
      expect(list.tracks).toEqual(['tid-1'])
      expect(list.routes).toEqual(['rid-1'])
    })

    it('uploadUnsyncedTracks uploads local activity tracks missing on server via PUT /api/tracks/:id', async () => {
      const transport = createMockTransport()

      // Seed local storage with track data
      await memoryAdapter.writeTrack('2026/act-1.json', { id: 'act-1', points: [{ lat: 10, lon: 20 }] })
      await memoryAdapter.writeTrack('2026/act-2.json', { id: 'act-2', points: [{ lat: 11, lon: 21 }] })

      const activities = [
        { id: 'act-1', trackPath: '2026/act-1.json' },
        { id: 'act-2', trackPath: '2026/act-2.json' },
        { id: 'act-pruned', trackPath: '2026/act-p.json', trackPruned: true }
      ]

      // Server already has act-1, but not act-2
      const uploaded = await uploadUnsyncedTracks({
        api: transport,
        adapter: memoryAdapter,
        activities,
        serverTracks: ['act-1']
      })

      expect(uploaded).toEqual(['act-2'])
      expect(transport).toHaveBeenCalledWith('/api/tracks/act-2', {
        method: 'PUT',
        body: JSON.stringify({ id: 'act-2', points: [{ lat: 11, lon: 21 }] })
      })
      expect(transport).not.toHaveBeenCalledWith('/api/tracks/act-1', expect.anything())
      expect(transport).not.toHaveBeenCalledWith('/api/tracks/act-pruned', expect.anything())
    })

    it('uploadUnsyncedRoutes uploads local routes missing on server via PUT /api/routes/:id', async () => {
      const transport = createMockTransport()

      await memoryAdapter.writeTrack('routes/route-1.json', { id: 'route-1', name: 'River Loop', points: [] })
      await memoryAdapter.writeTrack('routes/route-2.json', { id: 'route-2', name: 'Hill Climb', points: [] })

      const routes = [
        { id: 'route-1', trackPath: 'routes/route-1.json' },
        { id: 'route-2', trackPath: 'routes/route-2.json' }
      ]

      const uploaded = await uploadUnsyncedRoutes({
        api: transport,
        adapter: memoryAdapter,
        routes,
        serverRoutes: ['route-1']
      })

      expect(uploaded).toEqual(['route-2'])
      expect(transport).toHaveBeenCalledWith('/api/routes/route-2', {
        method: 'PUT',
        body: JSON.stringify({ id: 'route-2', name: 'Hill Climb', points: [] })
      })
      expect(transport).not.toHaveBeenCalledWith('/api/routes/route-1', expect.anything())
    })

    it('reconcileTracksAndRoutes coordinates full synchronization cycle', async () => {
      const transport = createMockTransport({
        '/api/tracks': { tracks: ['server-t1'], routes: [] }
      })

      await memoryAdapter.writeTrack('2026/local-t1.json', { id: 'local-t1', points: [] })
      await memoryAdapter.writeTrack('routes/local-r1.json', { id: 'local-r1', points: [] })

      const res = await reconcileTracksAndRoutes({
        force: true,
        api: transport,
        adapter: memoryAdapter,
        activities: [{ id: 'local-t1', trackPath: '2026/local-t1.json' }],
        routes: [{ id: 'local-r1', trackPath: 'routes/local-r1.json' }]
      })

      expect(res.ok).toBe(true)
      expect(res.uploadedTracks).toEqual(['local-t1'])
      expect(res.uploadedRoutes).toEqual(['local-r1'])
      expect(res.serverTracks).toContain('server-t1')
      expect(res.serverTracks).toContain('local-t1')
      expect(res.serverRoutes).toContain('local-r1')
    })

    it('reconcileTracksAndRoutes skips quietly when not in server mode and not forced', async () => {
      const transport = createMockTransport()
      useStore.setState({ user: null })

      const res = await reconcileTracksAndRoutes({
        api: transport,
        adapter: memoryAdapter
      })

      expect(res.skipped).toBe(true)
      expect(transport).not.toHaveBeenCalled()
    })
  })

  describe('Lazy Download & Caching', () => {
    it('lazyFetchTrack returns local track data without network call if present', async () => {
      const transport = createMockTransport()
      const localData = { id: 'track-cached', points: [{ lat: 45, lon: -122 }] }
      await memoryAdapter.writeTrack('2026/track-cached.json', localData)

      const result = await lazyFetchTrack(
        { id: 'track-cached', trackPath: '2026/track-cached.json' },
        { api: transport, adapter: memoryAdapter }
      )

      expect(result).toEqual(localData)
      expect(transport).not.toHaveBeenCalled()
    })

    it('lazyFetchTrack fetches GET /api/tracks/:id, caches in adapter, and registers as server-cached', async () => {
      const serverTrack = { id: 'remote-1', points: [{ lat: 50, lon: 14 }] }
      const transport = createMockTransport({
        '/api/tracks/remote-1': serverTrack
      })

      expect(await memoryAdapter.readTrack('2026/remote-1.json')).toBeNull()

      const result = await lazyFetchTrack(
        { id: 'remote-1', trackPath: '2026/remote-1.json' },
        { api: transport, adapter: memoryAdapter }
      )

      expect(result).toEqual(serverTrack)
      expect(transport).toHaveBeenCalledWith('/api/tracks/remote-1', { method: 'GET' })

      // Verify cached into adapter
      const cached = await memoryAdapter.readTrack('2026/remote-1.json')
      expect(cached).toEqual(serverTrack)

      // Verify registered in server-cached tracking registry
      expect(isCachedServerTrack('2026/remote-1.json')).toBe(true)
      expect(getCachedServerTracks()).toContain('2026/remote-1.json')
    })

    it('lazyFetchRoute returns local route if present without network call', async () => {
      const transport = createMockTransport()
      const localRoute = { id: 'route-cached', name: 'Downtown Run', points: [] }
      await memoryAdapter.writeTrack('routes/route-cached.json', localRoute)

      const result = await lazyFetchRoute(
        { id: 'route-cached', trackPath: 'routes/route-cached.json' },
        { api: transport, adapter: memoryAdapter }
      )

      expect(result).toEqual(localRoute)
      expect(transport).not.toHaveBeenCalled()
    })

    it('lazyFetchRoute fetches GET /api/routes/:id and caches in adapter', async () => {
      const serverRoute = { id: 'srv-route', name: 'Lake Loop', points: [{ lat: 40, lon: -73 }] }
      const transport = createMockTransport({
        '/api/routes/srv-route': serverRoute
      })

      const result = await lazyFetchRoute('srv-route', {
        api: transport,
        adapter: memoryAdapter
      })

      expect(result).toEqual(serverRoute)
      expect(transport).toHaveBeenCalledWith('/api/routes/srv-route', { method: 'GET' })

      const cached = await memoryAdapter.readTrack('routes/srv-route.json')
      expect(cached).toEqual(serverRoute)
      expect(isCachedServerTrack('routes/srv-route.json')).toBe(true)
    })
  })

  describe('Deletion Propagation', () => {
    it('deleteRemoteTrack issues DELETE /api/tracks/:id', async () => {
      const transport = createMockTransport()
      await deleteRemoteTrack('t-del-1', { api: transport })

      expect(transport).toHaveBeenCalledWith('/api/tracks/t-del-1', { method: 'DELETE' })
    })

    it('deleteRemoteRoute issues DELETE /api/routes/:id', async () => {
      const transport = createMockTransport()
      await deleteRemoteRoute('r-del-1', { api: transport })

      expect(transport).toHaveBeenCalledWith('/api/routes/r-del-1', { method: 'DELETE' })
    })

    it('pruneRemoteTracks issues POST /api/tracks/prune with ids and cutoff', async () => {
      const transport = createMockTransport()
      const cutoff = new Date('2025-01-01T00:00:00Z')

      await pruneRemoteTracks(
        { ids: ['t-old-1', 't-old-2'], cutoff },
        { api: transport }
      )

      expect(transport).toHaveBeenCalledWith('/api/tracks/prune', {
        method: 'POST',
        body: JSON.stringify({
          ids: ['t-old-1', 't-old-2'],
          cutoff: '2025-01-01T00:00:00.000Z'
        })
      })
    })

    it('propagateTrackDeletion deletes from adapter and issues remote DELETE when in server mode', async () => {
      const transport = createMockTransport()
      await memoryAdapter.writeTrack('2026/t-prop.json', { id: 't-prop' })

      await propagateTrackDeletion(
        { id: 't-prop', trackPath: '2026/t-prop.json' },
        { api: transport, adapter: memoryAdapter, force: true }
      )

      expect(await memoryAdapter.readTrack('2026/t-prop.json')).toBeNull()
      expect(transport).toHaveBeenCalledWith('/api/tracks/t-prop', { method: 'DELETE' })
    })

    it('propagateRouteDeletion deletes from adapter and issues remote DELETE when in server mode', async () => {
      const transport = createMockTransport()
      await memoryAdapter.writeTrack('routes/r-prop.json', { id: 'r-prop' })

      await propagateRouteDeletion(
        { id: 'r-prop', trackPath: 'routes/r-prop.json' },
        { api: transport, adapter: memoryAdapter, force: true }
      )

      expect(await memoryAdapter.readTrack('routes/r-prop.json')).toBeNull()
      expect(transport).toHaveBeenCalledWith('/api/routes/r-prop', { method: 'DELETE' })
    })

    it('propagateTrackPrune issues POST /api/tracks/prune when server mode is active', async () => {
      const transport = createMockTransport()
      await propagateTrackPrune(
        { ids: ['p1', 'p2'], cutoff: '2024-01-01T00:00:00.000Z' },
        { api: transport, force: true }
      )

      expect(transport).toHaveBeenCalledWith('/api/tracks/prune', {
        method: 'POST',
        body: JSON.stringify({ ids: ['p1', 'p2'], cutoff: '2024-01-01T00:00:00.000Z' })
      })
    })
  })

  describe('Server Disconnect Cleanup', () => {
    it('cleanupCachedServerTracks deletes recorded server-cached files from adapter', async () => {
      await memoryAdapter.writeTrack('2026/srv-track-1.json', { id: 'srv-track-1' })
      await memoryAdapter.writeTrack('2026/srv-track-2.json', { id: 'srv-track-2' })
      await memoryAdapter.writeTrack('2026/local-only.json', { id: 'local-only' })

      markCachedServerTrack('2026/srv-track-1.json')
      markCachedServerTrack('2026/srv-track-2.json')

      expect(getCachedServerTracks()).toHaveLength(2)

      const deleted = await cleanupCachedServerTracks({ adapter: memoryAdapter })

      expect(deleted).toContain('2026/srv-track-1.json')
      expect(deleted).toContain('2026/srv-track-2.json')

      // Files cached from server are deleted
      expect(await memoryAdapter.readTrack('2026/srv-track-1.json')).toBeNull()
      expect(await memoryAdapter.readTrack('2026/srv-track-2.json')).toBeNull()

      // Local only track was untouched
      expect(await memoryAdapter.readTrack('2026/local-only.json')).not.toBeNull()

      // Registry is cleared
      expect(getCachedServerTracks()).toHaveLength(0)
    })

    it('cleanupCachedServerTracks with all: true wipes all non-recovery track and route files', async () => {
      await memoryAdapter.writeTrack('2026/any-track.json', { id: 'any-track' })
      await memoryAdapter.writeTrack('routes/any-route.json', { id: 'any-route' })

      await cleanupCachedServerTracks({ adapter: memoryAdapter, all: true })

      expect(await memoryAdapter.readTrack('2026/any-track.json')).toBeNull()
      expect(await memoryAdapter.readTrack('routes/any-route.json')).toBeNull()
    })
  })

  describe('Store Integration (useStore)', () => {
    it('deleteCardioActivity deletes local track file and calls DELETE /api/tracks/:id in server mode', async () => {
      const transport = createMockTransport()
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      store.update(s => {
        s.cardioActivities = [{ id: 'act-to-delete', type: 'run', trackPath: '2026/act-to-delete.json' }]
      }, false)

      await memoryAdapter.writeTrack('2026/act-to-delete.json', { id: 'act-to-delete' })

      const removed = store.deleteCardioActivity('act-to-delete')
      expect(removed.id).toBe('act-to-delete')
      expect(useStore.getState().S.cardioActivities).toHaveLength(0)

      // Local file deleted
      expect(await memoryAdapter.readTrack('2026/act-to-delete.json')).toBeNull()

      // Remote DELETE call made
      expect(transport).toHaveBeenCalledWith('/api/tracks/act-to-delete', { method: 'DELETE' })
    })

    it('deleteRoute deletes local route file and calls DELETE /api/routes/:id in server mode', async () => {
      const transport = createMockTransport()
      setTransport(transport)

      const store = useStore.getState()
      store.setUser({ id: 'u1' })
      store.update(s => {
        s.routes = [{ id: 'route-to-delete', trackPath: 'routes/route-to-delete.json' }]
        s.savedRoutes = [{ id: 'route-to-delete', trackPath: 'routes/route-to-delete.json' }]
      }, false)

      await memoryAdapter.writeTrack('routes/route-to-delete.json', { id: 'route-to-delete' })

      const removed = store.deleteRoute('route-to-delete')
      expect(removed.id).toBe('route-to-delete')
      expect(useStore.getState().S.routes).toHaveLength(0)

      // Local file deleted
      expect(await memoryAdapter.readTrack('routes/route-to-delete.json')).toBeNull()

      // Remote DELETE call made
      expect(transport).toHaveBeenCalledWith('/api/routes/route-to-delete', { method: 'DELETE' })
    })

    it('disconnectServer with removeServerData cleans up cached tracks in cardio adapter', async () => {
      const store = useStore.getState()
      store.setUser({ id: 'u-server' })
      store.update(s => {
        s.cardioActivities = [{ id: 'c-srv', trackPath: '2026/c-srv.json' }]
        s.routes = [{ id: 'r-srv', trackPath: 'routes/r-srv.json' }]
      }, false)

      await memoryAdapter.writeTrack('2026/c-srv.json', { id: 'c-srv' })
      await memoryAdapter.writeTrack('routes/r-srv.json', { id: 'r-srv' })

      markCachedServerTrack('2026/c-srv.json')
      markCachedServerTrack('routes/r-srv.json')

      // Disconnect with removeServerData: true
      await store.disconnectServer({ removeServerData: true })

      expect(useStore.getState().user).toBeNull()
      expect(useStore.getState().S.cardioActivities).toHaveLength(0)

      // Cached tracks in adapter are cleaned up
      expect(await memoryAdapter.readTrack('2026/c-srv.json')).toBeNull()
      expect(await memoryAdapter.readTrack('routes/r-srv.json')).toBeNull()
    })

    it('disconnectServer without removeData keeps local track files intact', async () => {
      const store = useStore.getState()
      store.setUser({ id: 'u-server-keep' })
      store.update(s => {
        s.cardioActivities = [{ id: 'c-keep', trackPath: '2026/c-keep.json' }]
      }, false)

      await memoryAdapter.writeTrack('2026/c-keep.json', { id: 'c-keep' })

      await store.disconnectServer()

      expect(useStore.getState().user).toBeNull()
      expect(useStore.getState().S.cardioActivities).toHaveLength(1)
      expect(await memoryAdapter.readTrack('2026/c-keep.json')).not.toBeNull()
    })
  })
})
