import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  exportBackup,
  exportBackupJSON,
  importBackup,
  createLocalBackup,
  getLatestBackup,
  getLocalBackups,
  restoreLocalBackup,
  clearLocalBackups
} from './backup.js'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
  getCardioAdapter
} from './cardio-adapter.js'
import { useStore, DEF, exportBackup as storeExportBackup, importBackup as storeImportBackup } from '../store/useStore.js'
import { clearCachedServerTracksRegistry } from './track-sync.js'
import { setTransport, resetTransport } from './api.js'

function createLocalStorage(initial = {}) {
  let store = { ...initial }
  return {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
    key: vi.fn(i => Object.keys(store)[i] ?? null),
    get length() { return Object.keys(store).length },
    get _store() { return store }
  }
}

describe('Single-file JSON Backup Export/Import with Tracks & Routes (Issue #82)', () => {
  let memoryAdapter
  let apiCalls
  let storage

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
      return { ok: true }
    })
  }

  beforeEach(() => {
    storage = createLocalStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true
    })

    memoryAdapter = createMemoryCardioAdapter()
    setCardioAdapter(memoryAdapter)
    clearCachedServerTracksRegistry()
    apiCalls = []
    resetTransport()
    useStore.setState({
      S: JSON.parse(JSON.stringify(DEF)),
      user: null
    })
  })

  afterEach(() => {
    resetTransport()
  })

  describe('Exporting a JSON backup', () => {
    it('gathers state blob and bundles compact activity tracks and route files', async () => {
      const track1 = {
        id: 'act-run-1',
        type: 'run',
        points: [
          { lat: 45.1, lon: 9.1, t: 1000 },
          { lat: 45.2, lon: 9.2, t: 2000 }
        ]
      }
      const track2 = {
        id: 'act-ride-2',
        type: 'ride',
        points: [
          { lat: 46.1, lon: 8.1, t: 3000 }
        ]
      }
      const route1 = {
        id: 'route-mountain',
        name: 'Mountain Trail',
        points: [
          { lat: 47.0, lon: 7.0 }
        ]
      }

      await memoryAdapter.writeTrack('2026/act-run-1.json', track1)
      await memoryAdapter.writeTrack('2026/act-ride-2.json', track2)
      await memoryAdapter.writeTrack('routes/route-mountain.json', route1)

      const state = {
        ...JSON.parse(JSON.stringify(DEF)),
        workouts: [{ id: 'w1', name: 'Leg Day' }],
        cardioActivities: [
          { id: 'act-run-1', type: 'run', trackPath: '2026/act-run-1.json' },
          { id: 'act-ride-2', type: 'ride', trackPath: '2026/act-ride-2.json' },
          { id: 'act-no-track', type: 'walk' } // Activity without track file
        ],
        routes: [
          { id: 'route-mountain', name: 'Mountain Trail', trackPath: 'routes/route-mountain.json' }
        ]
      }

      const backup = await exportBackup(state, { adapter: memoryAdapter })

      expect(backup.version).toBe(1)
      expect(typeof backup.timestamp).toBe('number')
      expect(typeof backup.date).toBe('string')
      expect(backup.state.workouts).toEqual([{ id: 'w1', name: 'Leg Day' }])
      expect(backup.state.cardioActivities).toHaveLength(3)

      // Bundled tracks
      expect(backup.tracks['2026/act-run-1.json']).toEqual(track1)
      expect(backup.tracks['2026/act-ride-2.json']).toEqual(track2)
      expect(backup.tracks['act-no-track.json']).toBeUndefined()

      // Bundled route files
      expect(backup.routeFiles['routes/route-mountain.json']).toEqual(route1)

      // JSON string representation
      const jsonStr = backup.json
      expect(typeof jsonStr).toBe('string')
      const parsed = JSON.parse(jsonStr)
      expect(parsed.state.workouts[0].name).toBe('Leg Day')
      expect(parsed.tracks['2026/act-run-1.json'].points).toHaveLength(2)
      expect(parsed.routeFiles['routes/route-mountain.json'].name).toBe('Mountain Trail')
    })

    it('bundles routes from savedRoutes array if present in state', async () => {
      const savedRoute = { id: 'saved-1', name: 'River Loop', points: [] }
      await memoryAdapter.writeTrack('routes/saved-1.json', savedRoute)

      const state = {
        ...JSON.parse(JSON.stringify(DEF)),
        savedRoutes: [{ id: 'saved-1', trackPath: 'routes/saved-1.json' }]
      }

      const backup = await exportBackup(state, { adapter: memoryAdapter })
      expect(backup.routeFiles['routes/saved-1.json']).toEqual(savedRoute)
    })

    it('bundles unreferenced adapter tracks and routes via adapter.listTracks', async () => {
      const extraTrack = { id: 'extra-track', points: [] }
      const extraRoute = { id: 'extra-route', name: 'Secret Path', points: [] }
      await memoryAdapter.writeTrack('2026/extra-track.json', extraTrack)
      await memoryAdapter.writeTrack('routes/extra-route.json', extraRoute)

      const state = {
        ...JSON.parse(JSON.stringify(DEF)),
        cardioActivities: [],
        routes: []
      }

      const backup = await exportBackup(state, { adapter: memoryAdapter })
      expect(backup.tracks['2026/extra-track.json']).toEqual(extraTrack)
      expect(backup.routeFiles['routes/extra-route.json']).toEqual(extraRoute)
    })

    it('exportBackupJSON returns formatted JSON string', async () => {
      const state = {
        ...JSON.parse(JSON.stringify(DEF)),
        workouts: [{ id: 'w-json', name: 'Chest' }]
      }
      const json = await exportBackupJSON(state, { adapter: memoryAdapter })
      expect(typeof json).toBe('string')
      const parsed = JSON.parse(json)
      expect(parsed.state.workouts[0].name).toBe('Chest')
      expect(parsed.tracks).toEqual({})
      expect(parsed.routeFiles).toEqual({})
    })
  })

  describe('Importing a JSON backup', () => {
    it('restores state blob and writes all bundled tracks and route files to device storage', async () => {
      const trackData = { id: 'imported-act-1', type: 'run', points: [{ lat: 1, lon: 2 }] }
      const routeData = { id: 'imported-route-1', name: 'Loop', points: [{ lat: 3, lon: 4 }] }

      const backupPayload = {
        version: 1,
        timestamp: Date.now(),
        date: new Date().toISOString(),
        state: {
          workouts: [{ id: 'w-imp', name: 'Shoulders' }],
          cardioActivities: [
            { id: 'imported-act-1', type: 'run', trackPath: '2026/imported-act-1.json' }
          ],
          routes: [
            { id: 'imported-route-1', trackPath: 'routes/imported-route-1.json' }
          ]
        },
        tracks: {
          '2026/imported-act-1.json': trackData
        },
        routeFiles: {
          'routes/imported-route-1.json': routeData
        }
      }

      const res = await importBackup(backupPayload, { adapter: memoryAdapter, store: useStore })
      expect(res.ok).toBe(true)
      expect(res.tracksCount).toBe(1)
      expect(res.routesCount).toBe(1)

      // State is restored in store
      expect(useStore.getState().S.workouts).toEqual([{ id: 'w-imp', name: 'Shoulders' }])
      expect(useStore.getState().S.cardioActivities).toHaveLength(1)
      expect(useStore.getState().S.routes).toHaveLength(1)

      // Tracks and routes are restored to adapter storage
      const restoredTrack = await memoryAdapter.readTrack('2026/imported-act-1.json')
      expect(restoredTrack).toEqual(trackData)
      const restoredRoute = await memoryAdapter.readTrack('routes/imported-route-1.json')
      expect(restoredRoute).toEqual(routeData)
    })

    it('accepts raw JSON string and handles pathOrId resolution', async () => {
      const trackData = { id: 'track-by-id', points: [] }
      const routeData = { id: 'route-by-id', name: 'Park', points: [] }

      const backupPayload = {
        version: 1,
        state: {
          workouts: [],
          cardioActivities: [{ id: 'track-by-id' }],
          routes: [{ id: 'route-by-id' }]
        },
        tracks: {
          'track-by-id': trackData
        },
        routeFiles: {
          'route-by-id': routeData
        }
      }

      const jsonStr = JSON.stringify(backupPayload)
      await importBackup(jsonStr, { adapter: memoryAdapter, store: useStore })

      expect(await memoryAdapter.readTrack('track-by-id.json')).toEqual(trackData)
      expect(await memoryAdapter.readTrack('track-by-id')).toEqual(trackData)
      expect(await memoryAdapter.readTrack('routes/route-by-id.json')).toEqual(routeData)
      expect(await memoryAdapter.readTrack('route-by-id')).toEqual(routeData)
    })

    it('queues sync/upload via track-sync when in server mode', async () => {
      const transport = createMockTransport({
        '/api/tracks': { tracks: [], routes: [] }
      })
      setTransport(transport)

      useStore.setState({
        user: { id: 'u-sync-1', name: 'Alice' }
      })

      const track = { id: 'srv-track', points: [{ lat: 10, lon: 20 }] }
      const route = { id: 'srv-route', name: 'Sync Route', points: [] }

      const backup = {
        version: 1,
        state: {
          workouts: [],
          cardioActivities: [{ id: 'srv-track', trackPath: '2026/srv-track.json' }],
          routes: [{ id: 'srv-route', trackPath: 'routes/srv-route.json' }]
        },
        tracks: {
          '2026/srv-track.json': track
        },
        routeFiles: {
          'routes/srv-route.json': route
        }
      }

      const res = await importBackup(backup, {
        adapter: memoryAdapter,
        store: useStore,
        isServerMode: true,
        awaitSync: true
      })

      expect(res.ok).toBe(true)
      expect(res.syncPromise).toBeTruthy()

      // Track and route were uploaded to server
      const uploadedTrackCall = apiCalls.find(c => c.path === '/api/tracks/srv-track' && c.method === 'PUT')
      expect(uploadedTrackCall).toBeTruthy()
      expect(uploadedTrackCall.body).toEqual(track)

      const uploadedRouteCall = apiCalls.find(c => c.path === '/api/routes/srv-route' && c.method === 'PUT')
      expect(uploadedRouteCall).toBeTruthy()
      expect(uploadedRouteCall.body).toEqual(route)
    })

    it('does not trigger server sync when in guest or offline mode', async () => {
      const transport = createMockTransport()
      setTransport(transport)

      useStore.setState({ user: null })

      const backup = {
        version: 1,
        state: {
          workouts: [],
          cardioActivities: [{ id: 'local-act', trackPath: '2026/local-act.json' }]
        },
        tracks: {
          '2026/local-act.json': { id: 'local-act' }
        }
      }

      const res = await importBackup(backup, {
        adapter: memoryAdapter,
        store: useStore,
        isServerMode: false
      })

      expect(res.ok).toBe(true)
      expect(res.syncPromise).toBeNull()
      expect(apiCalls.filter(c => c.method === 'PUT')).toHaveLength(0)
    })
  })

  describe('Backward Compatibility for Legacy Backups', () => {
    it('successfully imports legacy createLocalBackup format without tracks or routeFiles', async () => {
      const legacyBackup = {
        version: 1,
        timestamp: 1600000000000,
        date: '2020-09-13T12:26:40.000Z',
        state: {
          unit: 'kg',
          workouts: [{ id: 'leg-1', name: 'Legacy Squats' }],
          routines: [{ id: 'r-1', name: '5x5' }],
          cardioActivities: []
        }
      }

      const res = await importBackup(legacyBackup, { adapter: memoryAdapter, store: useStore })
      expect(res.ok).toBe(true)
      expect(res.tracksCount).toBe(0)
      expect(res.routesCount).toBe(0)

      expect(useStore.getState().S.workouts).toEqual([{ id: 'leg-1', name: 'Legacy Squats' }])
      expect(useStore.getState().S.routines).toEqual([{ id: 'r-1', name: '5x5' }])
    })

    it('successfully imports legacy raw state export without wrapper keys', async () => {
      const rawStateBackup = {
        unit: 'lbs',
        workouts: [{ id: 'raw-w1', name: 'Old Bench' }],
        routines: [{ id: 'raw-r1', name: 'Push Day' }],
        cardioActivities: [],
        gear: []
      }

      const res = await importBackup(rawStateBackup, { adapter: memoryAdapter, store: useStore })
      expect(res.ok).toBe(true)
      expect(res.tracksCount).toBe(0)
      expect(res.routesCount).toBe(0)

      expect(useStore.getState().S.unit).toBe('lbs')
      expect(useStore.getState().S.workouts).toEqual([{ id: 'raw-w1', name: 'Old Bench' }])
      expect(useStore.getState().S.routines).toEqual([{ id: 'raw-r1', name: 'Push Day' }])
    })

    it('rejects invalid backup inputs with clear error', async () => {
      await expect(importBackup(null)).rejects.toThrow('Missing backup data')
      await expect(importBackup('invalid-json{{{')).rejects.toThrow('Invalid backup JSON')
    })
  })

  describe('Full Export and Import Round-Trip', () => {
    it('exports and re-imports complete dataset preserving all state, tracks, and routes', async () => {
      // 1. Prepare initial dataset
      const runTrack = {
        id: 'act-run-full',
        type: 'run',
        points: [
          { lat: 41.9, lon: 12.5, ele: 20, time: '2026-11-12T08:00:00Z' },
          { lat: 41.91, lon: 12.51, ele: 22, time: '2026-11-12T08:01:00Z' }
        ]
      }
      const hikeTrack = {
        id: 'act-hike-full',
        type: 'hike',
        points: [
          { lat: 46.5, lon: 10.2, ele: 1500, time: '2026-11-12T09:00:00Z' }
        ]
      }
      const gpxRoute = {
        id: 'gpx-route-full',
        name: 'Alpine Loop',
        points: [
          { lat: 46.5, lon: 10.2, ele: 1500 },
          { lat: 46.51, lon: 10.21, ele: 1600 }
        ]
      }

      await memoryAdapter.writeTrack('2026/act-run-full.json', runTrack)
      await memoryAdapter.writeTrack('2026/act-hike-full.json', hikeTrack)
      await memoryAdapter.writeTrack('routes/gpx-route-full.json', gpxRoute)

      const initialS = {
        ...JSON.parse(JSON.stringify(DEF)),
        workouts: [{ id: 'w-round', name: 'Deadlift Day' }],
        routines: [{ id: 'r-round', name: 'Heavy Pull' }],
        cardioActivities: [
          { id: 'act-run-full', type: 'run', d: '2026-11-12', trackPath: '2026/act-run-full.json' },
          { id: 'act-hike-full', type: 'hike', d: '2026-11-12', trackPath: '2026/act-hike-full.json' }
        ],
        routes: [
          { id: 'gpx-route-full', name: 'Alpine Loop', trackPath: 'routes/gpx-route-full.json' }
        ]
      }

      useStore.setState({ S: initialS })

      // 2. Export single-file JSON backup
      const exported = await exportBackup(initialS, { adapter: memoryAdapter })
      const exportedJson = exported.json

      // 3. Clear store and storage to simulate a fresh device / restored state
      const freshAdapter = createMemoryCardioAdapter()
      setCardioAdapter(freshAdapter)
      useStore.setState({ S: JSON.parse(JSON.stringify(DEF)) })

      expect(await freshAdapter.readTrack('2026/act-run-full.json')).toBeNull()
      expect(await freshAdapter.readTrack('routes/gpx-route-full.json')).toBeNull()
      expect(useStore.getState().S.workouts).toEqual([])

      // 4. Import the single-file backup into fresh environment
      const importResult = await importBackup(exportedJson, {
        adapter: freshAdapter,
        store: useStore
      })

      expect(importResult.ok).toBe(true)

      // 5. Verify restored state
      const restoredS = useStore.getState().S
      expect(restoredS.workouts).toEqual([{ id: 'w-round', name: 'Deadlift Day' }])
      expect(restoredS.routines).toEqual([{ id: 'r-round', name: 'Heavy Pull' }])
      expect(restoredS.cardioActivities).toHaveLength(2)
      expect(restoredS.routes).toHaveLength(1)

      // 6. Verify restored tracks and route files
      const restoredRun = await freshAdapter.readTrack('2026/act-run-full.json')
      expect(restoredRun).toEqual(runTrack)
      const restoredHike = await freshAdapter.readTrack('2026/act-hike-full.json')
      expect(restoredHike).toEqual(hikeTrack)
      const restoredRoute = await freshAdapter.readTrack('routes/gpx-route-full.json')
      expect(restoredRoute).toEqual(gpxRoute)
    })
  })

  describe('useStore Integration', () => {
    it('supports useStore.getState().exportBackup() and importBackup()', async () => {
      const track = { id: 'store-act', points: [{ lat: 50, lon: 10 }] }
      await memoryAdapter.writeTrack('2026/store-act.json', track)

      useStore.setState({
        S: {
          ...JSON.parse(JSON.stringify(DEF)),
          workouts: [{ id: 'w-store', name: 'Arm Blast' }],
          cardioActivities: [{ id: 'store-act', type: 'run', trackPath: '2026/store-act.json' }]
        }
      })

      const exported = await useStore.getState().exportBackup({ adapter: memoryAdapter })
      expect(exported.tracks['2026/store-act.json']).toEqual(track)
      expect(exported.state.workouts[0].name).toBe('Arm Blast')

      const freshAdapter = createMemoryCardioAdapter()
      setCardioAdapter(freshAdapter)
      useStore.setState({ S: JSON.parse(JSON.stringify(DEF)) })

      await useStore.getState().importBackup(exported, { adapter: freshAdapter })
      expect(useStore.getState().S.workouts[0].name).toBe('Arm Blast')
      expect(await freshAdapter.readTrack('2026/store-act.json')).toEqual(track)
    })

    it('exports exportBackup and importBackup as named store exports', async () => {
      expect(typeof storeExportBackup).toBe('function')
      expect(typeof storeImportBackup).toBe('function')
    })
  })

  describe('Local Backup Helpers Preservation', () => {
    it('createLocalBackup, getLatestBackup, getLocalBackups, restoreLocalBackup, clearLocalBackups still function', () => {
      const testState = { workouts: [{ id: 'w-local', name: 'Local Test' }] }
      const backup = createLocalBackup(testState, 1700000005000)
      expect(backup).toBeTruthy()
      expect(backup.key).toBe('gym_backup_1700000005000')

      const latest = getLatestBackup()
      expect(latest.timestamp).toBe(1700000005000)

      const all = getLocalBackups()
      expect(all.length).toBeGreaterThanOrEqual(1)

      const restored = restoreLocalBackup(backup.key)
      expect(restored.workouts).toEqual([{ id: 'w-local', name: 'Local Test' }])

      clearLocalBackups()
      expect(getLatestBackup()).toBeNull()
      expect(getLocalBackups()).toHaveLength(0)
    })
  })
})
