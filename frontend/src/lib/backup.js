import { getCardioAdapter, normalizeTrackPath } from './cardio-adapter.js'
import {
  getTrackId,
  getRouteId,
  resolveActivityTrackPath,
  resolveRouteTrackPath,
  reconcileTracksAndRoutes
} from './track-sync.js'
import { resolveTrackPath } from './track-trim.js'

export const BACKUP_PREFIX = 'gym_backup_'
export const LATEST_BACKUP_KEY = 'gym_backup_latest'

const DEFAULT_STATE = {
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], cardioActivities: [], routes: [], savedRoutes: [], gear: [], active: null, customEx: [], gifSize: 'full',
  reminder: { on: false, time: '08:00', tz: null }, effort: null
}

function resolveTrackFilePath(keyOrId, trackData, activities = []) {
  if (!keyOrId) return ''
  const norm = normalizeTrackPath(keyOrId)
  if (norm.includes('/') || norm.endsWith('.json')) {
    return norm
  }
  const match = activities.find(a => a && (a.id === keyOrId || a.trackPath === keyOrId))
  if (match) {
    const actPath = resolveActivityTrackPath(match)
    if (actPath) return actPath
  }
  if (trackData && typeof trackData === 'object') {
    const fromTrack = resolveTrackPath(trackData)
    if (fromTrack) return fromTrack
  }
  return `${norm}.json`
}

function resolveRouteFilePath(keyOrId, routeData, routes = []) {
  if (!keyOrId) return ''
  const norm = normalizeTrackPath(keyOrId)
  if (norm.startsWith('routes/')) {
    return norm.endsWith('.json') ? norm : `${norm}.json`
  }
  const match = routes.find(r => r && (r.id === keyOrId || r.trackPath === keyOrId))
  if (match) {
    const routePath = resolveRouteTrackPath(match)
    if (routePath) return routePath
  }
  return resolveRouteTrackPath(norm)
}

export function createLocalBackup(state, timestamp = Date.now()) {
  let target = state
  if (!target && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem('gym_state_v1')
      if (raw) target = JSON.parse(raw)
    } catch {}
  }
  if (!target) return null

  const ts = typeof timestamp === 'number' ? timestamp : Date.now()
  const key = `${BACKUP_PREFIX}${ts}`
  const backup = {
    version: 1,
    timestamp: ts,
    date: new Date(ts).toISOString(),
    state: JSON.parse(JSON.stringify(target))
  }
  const payload = JSON.stringify(backup)
  try {
    localStorage.setItem(key, payload)
    localStorage.setItem(LATEST_BACKUP_KEY, payload)
    return { key, ...backup }
  } catch (e) {
    return null
  }
}

export const saveLocalBackup = createLocalBackup
export const createBackup = createLocalBackup

export function getLatestBackup() {
  try {
    const raw = localStorage.getItem(LATEST_BACKUP_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  const list = getLocalBackups()
  return list[0] || null
}

export function getLocalBackups() {
  const backups = []
  try {
    const keys = typeof localStorage.key === 'function'
      ? Array.from({ length: localStorage.length || 0 }, (_, i) => localStorage.key(i))
      : (localStorage._store ? Object.keys(localStorage._store) : [])
    for (const key of keys) {
      if (key && key.startsWith(BACKUP_PREFIX)) {
        try {
          const item = JSON.parse(localStorage.getItem(key))
          backups.push({ key, ...item })
        } catch {}
      }
    }
  } catch {}
  return backups.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
}

export function restoreLocalBackup(keyOrBackup) {
  let backup = keyOrBackup
  if (typeof keyOrBackup === 'string') {
    try {
      backup = JSON.parse(localStorage.getItem(keyOrBackup))
    } catch {
      return null
    }
  }
  return backup?.state || null
}

export function clearLocalBackups() {
  try {
    const keys = typeof localStorage.key === 'function'
      ? Array.from({ length: localStorage.length || 0 }, (_, i) => localStorage.key(i))
      : (localStorage._store ? Object.keys(localStorage._store) : [])
    for (const key of keys) {
      if (key && (key.startsWith(BACKUP_PREFIX) || key === LATEST_BACKUP_KEY)) {
        localStorage.removeItem(key)
      }
    }
  } catch {}
}

/**
 * Exports a single-file JSON backup bundling state, compact activity tracks,
 * and saved GPX routes (Issue #82).
 *
 * @param {Object} [stateOrOptions] - App state or options object
 * @param {Object} [maybeOptions] - Additional options when state is passed first
 * @returns {Promise<Object>} Backup bundle object containing version, timestamp, state, tracks, routeFiles
 */
export async function exportBackup(stateOrOptions = {}, maybeOptions = {}) {
  let targetState = null
  let options = {}

  if (
    stateOrOptions &&
    (stateOrOptions.workouts ||
      stateOrOptions.routines ||
      stateOrOptions.cardioActivities ||
      stateOrOptions.routes ||
      stateOrOptions.savedRoutes ||
      stateOrOptions.unit)
  ) {
    targetState = stateOrOptions
    options = maybeOptions || {}
  } else if (stateOrOptions && stateOrOptions.state) {
    targetState = stateOrOptions.state
    options = stateOrOptions
  } else {
    options = stateOrOptions || {}
    targetState = options.state
  }

  const store = options.store
  if (!targetState && store && typeof store.getState === 'function') {
    targetState = store.getState()?.S
  }
  if (!targetState && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem('gym_state_v1')
      if (raw) targetState = JSON.parse(raw)
    } catch {}
  }
  if (!targetState) {
    targetState = DEFAULT_STATE
  }

  const stateBlob = JSON.parse(JSON.stringify(targetState))
  const adapter = options.adapter || getCardioAdapter()
  const tracks = {}
  const routeFiles = {}

  // 1. Gather track files for activities in state.cardioActivities
  const activities = Array.isArray(stateBlob.cardioActivities) ? stateBlob.cardioActivities : []
  for (const act of activities) {
    if (!act) continue
    const path = resolveActivityTrackPath(act)
    const id = act.id || getTrackId(path)
    let trackData = null
    if (path) {
      try { trackData = await adapter.readTrack(path) } catch {}
    }
    if (!trackData && id) {
      try { trackData = await adapter.readTrack(id) } catch {}
    }
    if (!trackData && id) {
      try { trackData = await adapter.readTrack(`${id}.json`) } catch {}
    }
    if (trackData) {
      const key = act.trackPath || path || (id ? `${id}.json` : '')
      if (key) {
        tracks[key] = typeof trackData === 'string' ? JSON.parse(trackData) : trackData
      }
    }
  }

  // 2. Gather route files for routes in state.routes / state.savedRoutes
  const routes = [
    ...(Array.isArray(stateBlob.routes) ? stateBlob.routes : []),
    ...(Array.isArray(stateBlob.savedRoutes) ? stateBlob.savedRoutes : [])
  ]
  for (const r of routes) {
    if (!r) continue
    const path = resolveRouteTrackPath(r)
    const id = r.id || getRouteId(path)
    let routeData = null
    if (path) {
      try { routeData = await adapter.readTrack(path) } catch {}
    }
    if (!routeData && id) {
      try { routeData = await adapter.readTrack(`routes/${id}.json`) } catch {}
    }
    if (!routeData && id) {
      try { routeData = await adapter.readTrack(id) } catch {}
    }
    if (routeData) {
      const key = r.trackPath || path || (id ? `routes/${id}.json` : '')
      if (key) {
        routeFiles[key] = typeof routeData === 'string' ? JSON.parse(routeData) : routeData
      }
    }
  }

  // 3. Gather any additional track/route files from storage adapter
  if (typeof adapter.listTracks === 'function') {
    try {
      const allFiles = await adapter.listTracks()
      for (const file of allFiles) {
        if (!file || file.includes('recovery')) continue
        if (file.startsWith('routes/')) {
          if (!routeFiles[file]) {
            try {
              const rData = await adapter.readTrack(file)
              if (rData) {
                routeFiles[file] = typeof rData === 'string' ? JSON.parse(rData) : rData
              }
            } catch {}
          }
        } else {
          if (!tracks[file]) {
            try {
              const tData = await adapter.readTrack(file)
              if (tData) {
                tracks[file] = typeof tData === 'string' ? JSON.parse(tData) : tData
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  const ts = typeof options.timestamp === 'number' ? options.timestamp : Date.now()
  const backup = {
    version: 1,
    timestamp: ts,
    date: new Date(ts).toISOString(),
    state: stateBlob,
    tracks,
    routeFiles
  }

  Object.defineProperty(backup, 'json', {
    get() {
      return JSON.stringify(backup, null, options.space ?? 2)
    },
    enumerable: false,
    configurable: true
  })

  if (options.asString || options.stringify) {
    return backup.json
  }

  return backup
}

/**
 * Exports backup as a JSON string.
 */
export async function exportBackupJSON(stateOrOptions, maybeOptions) {
  const backup = await exportBackup(stateOrOptions, maybeOptions)
  return backup.json
}

/**
 * Imports a JSON backup, restoring state and bundled compact tracks and GPX routes (Issue #82).
 *
 * @param {string|Object} backupData - Raw JSON string or parsed backup object
 * @param {Object} [options] - Options (adapter, store, isServerMode, etc.)
 * @returns {Promise<Object>} Import result object
 */
export async function importBackup(backupData, options = {}) {
  if (!backupData) {
    throw new Error('Missing backup data')
  }

  let backup = backupData
  if (typeof backupData === 'string') {
    try {
      backup = JSON.parse(backupData)
    } catch (err) {
      throw new Error(`Invalid backup JSON: ${err.message}`)
    }
  }

  if (!backup || typeof backup !== 'object') {
    throw new Error('Invalid backup format: expected JSON object')
  }

  // 1. Restore state blob (support modern wrapper format or legacy raw state)
  let stateBlob = null
  if (backup.state && typeof backup.state === 'object') {
    stateBlob = JSON.parse(JSON.stringify(backup.state))
  } else {
    // Legacy backup where root object is the state blob
    stateBlob = JSON.parse(JSON.stringify(backup))
    delete stateBlob.tracks
    delete stateBlob.routeFiles
    delete stateBlob.version
    delete stateBlob.timestamp
    delete stateBlob.date
  }

  const mergedState = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), stateBlob)
  const store = options.store
  const push = options.push ?? false

  if (options.applyState !== false) {
    if (store && typeof store.getState === 'function' && typeof store.getState().replaceState === 'function') {
      store.getState().replaceState(mergedState, push)
    } else if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('gym_state_v1', JSON.stringify(mergedState))
      } catch {}
    }
  }

  // 2. Restore bundled tracks to private device storage via adapter.writeTrack
  const adapter = options.adapter || getCardioAdapter()
  const tracks = backup.tracks || backup.state?.tracks || {}
  const restoredTracks = []

  for (const [key, trackData] of Object.entries(tracks)) {
    if (!trackData) continue
    const targetPath = resolveTrackFilePath(key, trackData, stateBlob.cardioActivities || [])
    await adapter.writeTrack(targetPath, trackData)
    if (key && key !== targetPath) {
      await adapter.writeTrack(key, trackData)
    }
    restoredTracks.push(targetPath)
  }

  // 3. Restore bundled route files to private device storage via adapter.writeTrack
  const routeFiles = backup.routeFiles || backup.state?.routeFiles || {}
  const restoredRoutes = []

  const routes = [
    ...(Array.isArray(stateBlob.routes) ? stateBlob.routes : []),
    ...(Array.isArray(stateBlob.savedRoutes) ? stateBlob.savedRoutes : [])
  ]
  for (const [key, routeData] of Object.entries(routeFiles)) {
    if (!routeData) continue
    const targetPath = resolveRouteFilePath(key, routeData, routes)
    await adapter.writeTrack(targetPath, routeData)
    if (key && key !== targetPath) {
      await adapter.writeTrack(key, routeData)
    }
    restoredRoutes.push(targetPath)
  }

  // 4. Server mode sync queueing via track-sync
  const isServer = options.isServerMode !== undefined
    ? Boolean(options.isServerMode)
    : Boolean(
        (store && typeof store.getState === 'function' && store.getState().isServerMode?.()) ||
        store?.getState?.()?.user
      )

  let syncPromise = null
  if (isServer && options.sync !== false) {
    syncPromise = reconcileTracksAndRoutes({
      store,
      adapter,
      force: true,
      ...options.syncOptions
    }).catch(() => {})
    if (options.awaitSync) {
      await syncPromise
    }
  }

  return {
    ok: true,
    state: mergedState,
    tracks,
    routeFiles,
    restoredTracks,
    restoredRoutes,
    tracksCount: restoredTracks.length,
    routesCount: restoredRoutes.length,
    syncPromise
  }
}

