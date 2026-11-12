/**
 * Client track & route synchronization subsystem (Issue #80).
 *
 * Implements:
 * 1. Background reconciliation and upload of unsynced local track files
 *    (PUT /api/tracks/:id) and routes (PUT /api/routes/:id) against GET /api/tracks.
 * 2. On-demand lazy fetching of tracks (GET /api/tracks/:id) and routes
 *    (GET /api/routes/:id) when opened, caching into cardio storage adapter.
 * 3. Deletion and prune propagation with server:
 *    - DELETE /api/tracks/:id and DELETE /api/routes/:id on item removal.
 *    - POST /api/tracks/prune (and POST /api/routes/prune) on retention sweep.
 * 4. Server disconnect cleanup:
 *    - Removes cached server track files from cardio adapter when user
 *      disconnects with removeServerData.
 */

import { api } from './api.js'
import { getCardioAdapter } from './cardio-adapter.js'
import { resolveTrackPath } from './track-trim.js'
import { useStore } from '../store/useStore.js'

export const CACHED_SERVER_TRACKS_KEY = 'gym_cached_server_tracks'
const cachedServerTrackRegistry = new Set()

function loadCachedRegistry() {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(CACHED_SERVER_TRACKS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item) cachedServerTrackRegistry.add(item)
          }
        }
      }
    } catch {}
  }
}
loadCachedRegistry()

function persistCachedRegistry() {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(
        CACHED_SERVER_TRACKS_KEY,
        JSON.stringify(Array.from(cachedServerTrackRegistry))
      )
    } catch {}
  }
}

/**
 * Registers a track path as cached from the server.
 */
export function markCachedServerTrack(trackPath) {
  if (!trackPath) return
  cachedServerTrackRegistry.add(trackPath)
  persistCachedRegistry()
}

/**
 * Checks whether a track path was cached from the server.
 */
export function isCachedServerTrack(trackPath) {
  if (!trackPath) return false
  return cachedServerTrackRegistry.has(trackPath)
}

/**
 * Returns an array of track paths that were downloaded/cached from the server.
 */
export function getCachedServerTracks() {
  return Array.from(cachedServerTrackRegistry)
}

/**
 * Clears the registry of server-cached tracks.
 */
export function clearCachedServerTracksRegistry() {
  cachedServerTrackRegistry.clear()
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(CACHED_SERVER_TRACKS_KEY)
    } catch {}
  }
}

/**
 * Extracts the canonical track ID from a path or activity object.
 */
export function getTrackId(activityOrPath) {
  if (!activityOrPath) return ''
  if (typeof activityOrPath === 'string') {
    const parts = activityOrPath.replace(/\\/g, '/').split('/')
    const file = parts[parts.length - 1]
    return file.replace(/\.json$/, '')
  }
  return activityOrPath.id || ''
}

/**
 * Extracts the canonical route ID from a path or route object.
 */
export function getRouteId(routeOrPath) {
  if (!routeOrPath) return ''
  if (typeof routeOrPath === 'string') {
    const parts = routeOrPath.replace(/\\/g, '/').split('/')
    const file = parts[parts.length - 1]
    return file.replace(/\.json$/, '')
  }
  return routeOrPath.id || ''
}

/**
 * Resolves the relative track path in the cardio storage adapter for an activity.
 */
export function resolveActivityTrackPath(activityOrId) {
  if (!activityOrId) return ''
  if (typeof activityOrId === 'string') {
    return activityOrId.endsWith('.json') ? activityOrId : `${activityOrId}.json`
  }
  return (
    activityOrId.trackPath ||
    resolveTrackPath(activityOrId) ||
    (activityOrId.id ? `${activityOrId.id}.json` : '')
  )
}

/**
 * Resolves the relative track path in the cardio storage adapter for a route.
 */
export function resolveRouteTrackPath(routeOrId) {
  if (!routeOrId) return ''
  if (typeof routeOrId === 'string') {
    if (routeOrId.startsWith('routes/')) {
      return routeOrId.endsWith('.json') ? routeOrId : `${routeOrId}.json`
    }
    return routeOrId.endsWith('.json') ? `routes/${routeOrId}` : `routes/${routeOrId}.json`
  }
  return routeOrId.trackPath || (routeOrId.id ? `routes/${routeOrId.id}.json` : '')
}

/**
 * Queries GET /api/tracks to fetch IDs of tracks and routes stored on the server.
 */
export async function fetchServerTrackList(options = {}) {
  const apiFn = options.api || api
  try {
    const res = await apiFn('/api/tracks', { method: 'GET' })
    const tracks = Array.isArray(res?.tracks)
      ? res.tracks
      : Array.isArray(res?.trackIds)
        ? res.trackIds
        : []
    const routes = Array.isArray(res?.routes)
      ? res.routes
      : Array.isArray(res?.routeIds)
        ? res.routeIds
        : []
    return {
      tracks: tracks.map(String),
      routes: routes.map(String),
      raw: res
    }
  } catch (err) {
    if (options.throwOnError) throw err
    return { tracks: [], routes: [], error: err }
  }
}

/**
 * Uploads unsynced local activity tracks to PUT /api/tracks/:id.
 */
export async function uploadUnsyncedTracks(options = {}) {
  const apiFn = options.api || api
  const adapter = options.adapter || getCardioAdapter()
  const store = options.store || useStore
  const state = options.state || store?.getState?.()?.S || {}
  const activities = options.activities || state.cardioActivities || []
  const serverTracks =
    options.serverTracks instanceof Set
      ? options.serverTracks
      : new Set(options.serverTracks || [])
  const uploaded = []

  // 1. Process activities in store
  for (const act of activities) {
    if (!act || !act.id || act.trackPruned) continue
    if (serverTracks.has(act.id)) continue

    const path = resolveActivityTrackPath(act)
    let trackData = null
    try {
      trackData = await adapter.readTrack(path)
    } catch {}

    if (trackData) {
      try {
        await apiFn(`/api/tracks/${encodeURIComponent(act.id)}`, {
          method: 'PUT',
          body: typeof trackData === 'string' ? trackData : JSON.stringify(trackData)
        })
        serverTracks.add(act.id)
        uploaded.push(act.id)
      } catch (err) {
        if (options.throwOnError) throw err
      }
    }
  }

  // 2. Process any additional track files present in adapter
  if (typeof adapter.listTracks === 'function') {
    try {
      const allFiles = await adapter.listTracks()
      for (const filePath of allFiles) {
        if (!filePath || filePath.startsWith('routes/') || filePath.includes('recovery')) continue
        const id = getTrackId(filePath)
        if (!id || serverTracks.has(id)) continue

        const trackData = await adapter.readTrack(filePath)
        if (trackData) {
          try {
            await apiFn(`/api/tracks/${encodeURIComponent(id)}`, {
              method: 'PUT',
              body: typeof trackData === 'string' ? trackData : JSON.stringify(trackData)
            })
            serverTracks.add(id)
            uploaded.push(id)
          } catch (err) {
            if (options.throwOnError) throw err
          }
        }
      }
    } catch {}
  }

  return uploaded
}

/**
 * Uploads unsynced local routes to PUT /api/routes/:id.
 */
export async function uploadUnsyncedRoutes(options = {}) {
  const apiFn = options.api || api
  const adapter = options.adapter || getCardioAdapter()
  const store = options.store || useStore
  const state = options.state || store?.getState?.()?.S || {}
  const routes = options.routes || state.routes || state.savedRoutes || []
  const serverRoutes =
    options.serverRoutes instanceof Set
      ? options.serverRoutes
      : new Set(options.serverRoutes || [])
  const uploaded = []

  // 1. Process routes in store
  for (const r of routes) {
    if (!r || !r.id) continue
    if (serverRoutes.has(r.id)) continue

    const path = resolveRouteTrackPath(r)
    let routeData = null
    try {
      routeData = await adapter.readTrack(path)
    } catch {}

    if (routeData) {
      try {
        await apiFn(`/api/routes/${encodeURIComponent(r.id)}`, {
          method: 'PUT',
          body: typeof routeData === 'string' ? routeData : JSON.stringify(routeData)
        })
        serverRoutes.add(r.id)
        uploaded.push(r.id)
      } catch (err) {
        if (options.throwOnError) throw err
      }
    }
  }

  // 2. Process any additional route files present in adapter
  if (typeof adapter.listTracks === 'function') {
    try {
      const allFiles = await adapter.listTracks()
      for (const filePath of allFiles) {
        if (!filePath || !filePath.startsWith('routes/')) continue
        const id = getRouteId(filePath)
        if (!id || serverRoutes.has(id)) continue

        const routeData = await adapter.readTrack(filePath)
        if (routeData) {
          try {
            await apiFn(`/api/routes/${encodeURIComponent(id)}`, {
              method: 'PUT',
              body: typeof routeData === 'string' ? routeData : JSON.stringify(routeData)
            })
            serverRoutes.add(id)
            uploaded.push(id)
          } catch (err) {
            if (options.throwOnError) throw err
          }
        }
      }
    } catch {}
  }

  return uploaded
}

/**
 * Reconciles local track and route files against GET /api/tracks.
 * Uploads unsynced local track files via PUT /api/tracks/:id and routes via PUT /api/routes/:id.
 */
export async function reconcileTracksAndRoutes(options = {}) {
  const store = options.store || useStore
  const isServer =
    options.force ||
    (store?.getState?.()?.isServerMode ? store.getState().isServerMode() : false)

  if (!isServer && !options.force) {
    return { ok: true, skipped: true, uploadedTracks: [], uploadedRoutes: [] }
  }

  const serverList = await fetchServerTrackList(options)
  if (serverList.error) {
    return {
      ok: false,
      error: serverList.error,
      uploadedTracks: [],
      uploadedRoutes: []
    }
  }

  const serverTracksSet = new Set(serverList.tracks)
  const uploadedTracks = await uploadUnsyncedTracks({
    ...options,
    serverTracks: serverTracksSet
  })

  const serverRoutesSet = new Set(serverList.routes)
  const uploadedRoutes = await uploadUnsyncedRoutes({
    ...options,
    serverRoutes: serverRoutesSet
  })

  return {
    ok: true,
    serverTracks: Array.from(serverTracksSet),
    serverRoutes: Array.from(serverRoutesSet),
    uploadedTracks,
    uploadedRoutes
  }
}

export const reconcileTrackSync = reconcileTracksAndRoutes

/**
 * Lazy fetch of a track:
 * If track is already present locally in cardio storage adapter, returns local data.
 * Otherwise, fetches GET /api/tracks/:id, caches in adapter, marks as server-cached, and returns data.
 */
export async function lazyFetchTrack(activityOrId, options = {}) {
  const adapter = options.adapter || getCardioAdapter()
  const apiFn = options.api || api
  const store = options.store || useStore

  let id = ''
  let trackPath = ''

  if (typeof activityOrId === 'string') {
    id = activityOrId
    trackPath = options.trackPath
    if (!trackPath) {
      const activities = store?.getState?.()?.S?.cardioActivities || []
      const matched = activities.find(a => a.id === id)
      trackPath = matched ? resolveActivityTrackPath(matched) : `${id}.json`
    }
  } else if (activityOrId && typeof activityOrId === 'object') {
    id = activityOrId.id
    trackPath = resolveActivityTrackPath(activityOrId)
  }

  if (!id) return null

  // 1. Check local adapter
  try {
    const local = await adapter.readTrack(trackPath)
    if (local) return local
  } catch {}

  // 1b. Check if track exists under alternate path (e.g. 2026/id.json vs id.json)
  if (typeof adapter.listTracks === 'function') {
    try {
      const allFiles = await adapter.listTracks()
      const match = allFiles.find(f => getTrackId(f) === id && !f.startsWith('routes/'))
      if (match) {
        const local = await adapter.readTrack(match)
        if (local) return local
      }
    } catch {}
  }

  // 2. Fetch from server
  try {
    const data = await apiFn(`/api/tracks/${encodeURIComponent(id)}`, { method: 'GET' })
    if (data) {
      await adapter.writeTrack(trackPath, data)
      markCachedServerTrack(trackPath)
      return data
    }
    return null
  } catch (err) {
    if (options.throwOnError) throw err
    return null
  }
}

export const getOrFetchTrack = lazyFetchTrack

/**
 * Lazy fetch of a route:
 * If route is already present locally in cardio storage adapter, returns local data.
 * Otherwise, fetches GET /api/routes/:id, caches in adapter, marks as server-cached, and returns data.
 */
export async function lazyFetchRoute(routeOrId, options = {}) {
  const adapter = options.adapter || getCardioAdapter()
  const apiFn = options.api || api
  const store = options.store || useStore

  let id = ''
  let trackPath = ''

  if (typeof routeOrId === 'string') {
    id = routeOrId
    trackPath = options.trackPath
    if (!trackPath) {
      const routes = store?.getState?.()?.S?.routes || store?.getState?.()?.S?.savedRoutes || []
      const matched = routes.find(r => r.id === id)
      trackPath = matched ? resolveRouteTrackPath(matched) : `routes/${id}.json`
    }
  } else if (routeOrId && typeof routeOrId === 'object') {
    id = routeOrId.id
    trackPath = resolveRouteTrackPath(routeOrId)
  }

  if (!id) return null

  // 1. Check local adapter
  try {
    const local = await adapter.readTrack(trackPath)
    if (local) return local
  } catch {}

  // 2. Fetch from server
  try {
    const data = await apiFn(`/api/routes/${encodeURIComponent(id)}`, { method: 'GET' })
    if (data) {
      await adapter.writeTrack(trackPath, data)
      markCachedServerTrack(trackPath)
      return data
    }
    return null
  } catch (err) {
    if (options.throwOnError) throw err
    return null
  }
}

export const getOrFetchRoute = lazyFetchRoute

/**
 * Deletes a track from the server via DELETE /api/tracks/:id.
 */
export async function deleteRemoteTrack(id, options = {}) {
  const apiFn = options.api || api
  try {
    const res = await apiFn(`/api/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return res || { ok: true }
  } catch (err) {
    if (options.throwOnError) throw err
    return { ok: false, error: err }
  }
}

/**
 * Deletes a route from the server via DELETE /api/routes/:id.
 */
export async function deleteRemoteRoute(id, options = {}) {
  const apiFn = options.api || api
  try {
    const res = await apiFn(`/api/routes/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return res || { ok: true }
  } catch (err) {
    if (options.throwOnError) throw err
    return { ok: false, error: err }
  }
}

/**
 * Prunes expired tracks on the server via POST /api/tracks/prune.
 */
export async function pruneRemoteTracks(pruneOptions = {}, options = {}) {
  const apiFn = options.api || api
  const ids = Array.isArray(pruneOptions.ids)
    ? pruneOptions.ids
    : pruneOptions.trackIds || []
  const cutoff =
    pruneOptions.cutoff || pruneOptions.olderThan || pruneOptions.before || null

  const body = {}
  if (ids.length > 0) body.ids = ids
  if (cutoff) {
    body.cutoff =
      typeof cutoff === 'object' && cutoff.toISOString ? cutoff.toISOString() : cutoff
  }

  try {
    const res = await apiFn('/api/tracks/prune', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    return res || { ok: true }
  } catch (err) {
    if (options.throwOnError) throw err
    return { ok: false, error: err }
  }
}

/**
 * Prunes expired routes on the server via POST /api/routes/prune.
 */
export async function pruneRemoteRoutes(pruneOptions = {}, options = {}) {
  const apiFn = options.api || api
  const ids = Array.isArray(pruneOptions.ids)
    ? pruneOptions.ids
    : pruneOptions.routeIds || []
  const cutoff =
    pruneOptions.cutoff || pruneOptions.olderThan || pruneOptions.before || null

  const body = {}
  if (ids.length > 0) body.ids = ids
  if (cutoff) {
    body.cutoff =
      typeof cutoff === 'object' && cutoff.toISOString ? cutoff.toISOString() : cutoff
  }

  try {
    const res = await apiFn('/api/routes/prune', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    return res || { ok: true }
  } catch (err) {
    if (options.throwOnError) throw err
    return { ok: false, error: err }
  }
}

/**
 * Deletes an activity track locally from adapter and propagates DELETE /api/tracks/:id if connected to server.
 */
export async function propagateTrackDeletion(activityOrId, options = {}) {
  const id = typeof activityOrId === 'object' ? activityOrId?.id : activityOrId
  const path = resolveActivityTrackPath(activityOrId)
  const adapter = options.adapter || getCardioAdapter()

  if (path && adapter) {
    await adapter.deleteTrack(path).catch(() => {})
  }

  const store = options.store || useStore
  const isServer =
    options.force ||
    (options.isServerMode !== undefined
      ? options.isServerMode
      : store?.getState?.()?.isServerMode
        ? store.getState().isServerMode()
        : Boolean(store?.getState?.()?.user))

  if (isServer && id) {
    return await deleteRemoteTrack(id, options)
  }
  return { ok: true, localOnly: true }
}

/**
 * Deletes a route locally from adapter and propagates DELETE /api/routes/:id if connected to server.
 */
export async function propagateRouteDeletion(routeOrId, options = {}) {
  const id = typeof routeOrId === 'object' ? routeOrId?.id : routeOrId
  const path = resolveRouteTrackPath(routeOrId)
  const adapter = options.adapter || getCardioAdapter()

  if (path && adapter) {
    await adapter.deleteTrack(path).catch(() => {})
  }

  const store = options.store || useStore
  const isServer =
    options.force ||
    (options.isServerMode !== undefined
      ? options.isServerMode
      : store?.getState?.()?.isServerMode
        ? store.getState().isServerMode()
        : Boolean(store?.getState?.()?.user))

  if (isServer && id) {
    return await deleteRemoteRoute(id, options)
  }
  return { ok: true, localOnly: true }
}

/**
 * Propagates track retention pruning to server via POST /api/tracks/prune.
 */
export async function propagateTrackPrune(pruneInfo = {}, options = {}) {
  const store = options.store || useStore
  const isServer =
    options.force ||
    (options.isServerMode !== undefined
      ? options.isServerMode
      : store?.getState?.()?.isServerMode
        ? store.getState().isServerMode()
        : Boolean(store?.getState?.()?.user))

  if (isServer) {
    const ids = Array.isArray(pruneInfo.ids)
      ? pruneInfo.ids
      : Array.isArray(pruneInfo)
        ? pruneInfo.map(a => a?.id || a).filter(Boolean)
        : []
    const cutoff = pruneInfo.cutoff || pruneInfo.cutoffDate || null
    return await pruneRemoteTracks({ ids, cutoff }, options)
  }
  return { ok: true, localOnly: true }
}

/**
 * Server disconnect cleanup:
 * Removes cached server track files from the cardio storage adapter.
 */
export async function cleanupCachedServerTracks(options = {}) {
  const adapter = options.adapter || getCardioAdapter()
  const deleted = []
  const targets = new Set(cachedServerTrackRegistry)

  if (options.all || options.removeServerData) {
    if (typeof adapter.listTracks === 'function') {
      try {
        const allFiles = await adapter.listTracks()
        for (const f of allFiles) {
          if (f && !f.includes('recovery')) targets.add(f)
        }
      } catch {}
    }
    const store = options.store || useStore
    const activities = options.activities || store?.getState?.()?.S?.cardioActivities || []
    for (const act of activities) {
      const p = resolveActivityTrackPath(act)
      if (p) targets.add(p)
    }
    const routes = options.routes || store?.getState?.()?.S?.routes || []
    for (const r of routes) {
      const p = resolveRouteTrackPath(r)
      if (p) targets.add(p)
    }
  }

  for (const path of targets) {
    try {
      const ok = await adapter.deleteTrack(path)
      if (ok) deleted.push(path)
    } catch {}
  }

  clearCachedServerTracksRegistry()
  return deleted
}

export const cleanupServerTracks = cleanupCachedServerTracks
export const cleanCachedServerTracks = cleanupCachedServerTracks
