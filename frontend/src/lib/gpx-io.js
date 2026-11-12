// GPX Import and Export Subsystem (Issue #73).
//
// Provides:
//   1. exportGPX(data, options):
//      Serializes an activity, route, or points list to GPX 1.1 XML and triggers
//      either the OS share sheet on mobile (via shareExport) or a browser file download on web.
//   2. parseGPXInput(input):
//      Parses a GPX string, Blob, or File into points, metadata, and mathematical summary.
//   3. importGPXAsActivity(input, options):
//      Imports GPX as a completed cardio activity, writes the <year>/<id>.json track file,
//      and updates state.cardioActivities.
//   4. importGPXAsRoute(input, options):
//      Imports GPX as a saved route, writes the routes/<id>.json track file,
//      and updates state.routes / state.savedRoutes.
//   5. importGPX(input, destination, options):
//      Unified router dispatching to activity or route import.

import { parseGPX, serializeGPX } from './gpx.js'
import { MOBILE, shareExport } from './mobile.js'
import { getCardioAdapter } from './cardio-adapter.js'
import {
  analyzeTrack,
  totalDistance,
  computeElapsedTime,
  computeMovingTime,
  computeElevationGain
} from './track-math.js'
import { useStore } from '../store/useStore.js'
import { uid } from './format.js'

/**
 * Sanitizes a string for use in safe filenames.
 *
 * @param {string} str
 * @returns {string}
 */
export function sanitizeFilename(str) {
  if (!str) return 'track'
  const cleaned = String(str).trim().replace(/^(\.\.[/\\])+/, '')
  const sanitized = cleaned
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return sanitized || 'track'
}

/**
 * Computes an analytical track summary adapted for point count size.
 *
 * @param {Array} points
 * @param {Object} [options={}]
 * @returns {Object}
 */
export function summarizeTrackPoints(points, options = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    return analyzeTrack(points, options)
  }
  const elevationWindow = points.length < 5 ? 1 : 5
  return analyzeTrack(points, {
    elevationWindow,
    ...options
  })
}

/**
 * Initiates a browser file download for text/xml content.
 * Safe to call in test/non-DOM environments (returns false if DOM is unavailable).
 *
 * @param {string} content - File contents
 * @param {string} filename - Target download filename
 * @param {string} [mimeType='application/gpx+xml;charset=utf-8']
 * @returns {boolean} True if download was triggered
 */
export function triggerBrowserDownload(
  content,
  filename,
  mimeType = 'application/gpx+xml;charset=utf-8'
) {
  if (
    typeof document === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return false
  }

  try {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url)
      } catch {}
    }, 1000)
    return true
  } catch (err) {
    console.warn('triggerBrowserDownload failed:', err)
    return false
  }
}

/**
 * Exports activity, route, or points collection as GPX 1.1 XML.
 * Automatically delegates to shareExport on mobile or browser download on web.
 *
 * @param {Object|Array} data - Activity, route, track object, or array of points
 * @param {Object} [options={}] - Export options
 * @param {string} [options.name] - Custom track/route name
 * @param {string} [options.desc] - Custom description/notes
 * @param {string} [options.filename] - Custom output filename
 * @param {string} [options.type] - 'track' or 'route'
 * @param {boolean} [options.isMobile] - Override mobile detection
 * @param {Object} [options.adapter] - Override cardio adapter
 * @param {Function} [options.shareFn] - Override mobile share handler
 * @param {Function} [options.downloadFn] - Override web download handler
 * @returns {Promise<{ filename: string, content: string, success: boolean, isMobile: boolean }>}
 */
export async function exportGPX(data, options = {}) {
  if (!data) {
    throw new Error('No data provided for GPX export')
  }

  let points = []
  let name = options.name || ''
  let desc = options.desc || ''
  let type = options.type || 'track'
  let time = options.time || null
  const creator = options.creator || 'OpenGym'

  if (Array.isArray(data)) {
    points = data
  } else if (typeof data === 'object') {
    if (Array.isArray(data.points)) {
      points = data.points
    } else if (data.track && Array.isArray(data.track.points)) {
      points = data.track.points
    } else if (Array.isArray(data.waypoints)) {
      points = data.waypoints
    }

    // If points are empty but a trackPath is specified, load points from adapter
    if (points.length === 0 && (data.trackPath || data.path)) {
      const adapter = options.adapter || getCardioAdapter()
      if (adapter && typeof adapter.readTrack === 'function') {
        const loaded = await adapter.readTrack(data.trackPath || data.path)
        if (loaded) {
          if (Array.isArray(loaded.points)) {
            points = loaded.points
          } else if (Array.isArray(loaded)) {
            points = loaded
          }
        }
      }
    }

    if (!name) {
      name = data.name || (data.type ? `${data.type.toUpperCase()} - ${data.startTime || ''}`.trim() : 'OpenGym Activity')
    }
    if (!desc) {
      desc = data.desc || data.notes || ''
    }
    if (!options.type) {
      type = data.type === 'route' ? 'route' : 'track'
    }
    if (!time) {
      time = data.startTime || null
    }
  }

  if (!time && points.length > 0 && points[0].time) {
    time = points[0].time
  }

  const gpxContent = serializeGPX({
    name,
    desc,
    points,
    creator,
    type,
    time
  })

  let filename = options.filename
  if (!filename) {
    const baseName = sanitizeFilename(name || (type === 'route' ? 'route' : 'activity'))
    filename = `${baseName}.gpx`
  } else if (!filename.toLowerCase().endsWith('.gpx')) {
    filename = `${filename}.gpx`
  }

  const isMobile = options.isMobile !== undefined ? Boolean(options.isMobile) : MOBILE

  if (isMobile) {
    const share = options.shareFn || shareExport
    if (typeof share === 'function') {
      await share(gpxContent, filename)
    }
  } else {
    const download = options.downloadFn || triggerBrowserDownload
    if (typeof download === 'function') {
      download(gpxContent, filename)
    }
  }

  return {
    filename,
    content: gpxContent,
    success: true,
    isMobile
  }
}

/**
 * Reads a GPX input (string, Blob, or File) and parses it using parseGPX.
 * Also computes an analytical summary of the track points.
 *
 * @param {string|Blob|File} input - GPX content or file
 * @returns {Promise<{ name: string, desc: string, creator: string, points: Array, summary: Object, rawXml: string }>}
 */
export async function parseGPXInput(input) {
  if (!input) {
    throw new Error('Invalid or empty GPX input')
  }

  let xmlString = ''

  if (typeof input === 'string') {
    xmlString = input
  } else if (typeof input === 'object' && typeof input.text === 'function') {
    xmlString = await input.text()
  } else if (typeof FileReader !== 'undefined' && input instanceof Blob) {
    xmlString = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('Failed to read GPX file'))
      reader.readAsText(input)
    })
  } else {
    throw new Error('Unsupported GPX input type')
  }

  if (!xmlString || typeof xmlString !== 'string' || !xmlString.trim()) {
    throw new Error('Invalid GPX: file is empty')
  }

  const parsed = parseGPX(xmlString)
  const summary = summarizeTrackPoints(parsed.points)

  return {
    ...parsed,
    summary,
    rawXml: xmlString
  }
}

/**
 * Imports a GPX track as a completed cardio activity.
 * Writes the track file to the cardio adapter and adds the activity to the store.
 *
 * @param {string|Blob|File|Object} input - GPX XML string, file, or pre-parsed object
 * @param {Object} [options={}] - Import options
 * @param {string} [options.id] - Custom activity ID
 * @param {string} [options.type='run'] - Cardio activity type (run, ride, walk, hike)
 * @param {string} [options.name] - Custom activity name override
 * @param {string} [options.notes] - Custom notes override
 * @param {string} [options.startTime] - Custom start time override
 * @param {number} [options.durationMs] - Custom duration override in milliseconds
 * @param {number} [options.distanceM] - Custom distance override in meters
 * @param {string} [options.gearId] - Associated gear ID
 * @param {number} [options.rpe] - Rate of perceived exertion (1-10)
 * @param {Object} [options.adapter] - Cardio adapter override
 * @param {Object} [options.store] - Store override
 * @returns {Promise<{ activity: Object, trackPath: string, trackData: Object, summary: Object }>}
 */
export async function importGPXAsActivity(input, options = {}) {
  let parsed = null

  if (input && typeof input === 'object' && Array.isArray(input.points)) {
    parsed = {
      name: input.name || '',
      desc: input.desc || '',
      creator: input.creator || 'OpenGym',
      points: input.points,
      summary: input.summary || summarizeTrackPoints(input.points)
    }
  } else {
    parsed = await parseGPXInput(input)
  }

  if (!parsed.points || parsed.points.length === 0) {
    throw new Error('GPX contains no GPS trackpoints')
  }

  const summary = parsed.summary || summarizeTrackPoints(parsed.points)
  const id = options.id || uid()
  const type = options.type || options.activityType || 'run'
  const name = options.name || parsed.name || 'Imported Activity'
  const notes = options.notes !== undefined ? options.notes : (parsed.desc || '')

  let startTime = options.startTime
  if (!startTime && parsed.points[0]?.time) {
    startTime = parsed.points[0].time
  }
  if (!startTime) {
    startTime = new Date().toISOString()
  }

  const endTime =
    parsed.points[parsed.points.length - 1]?.time ||
    new Date(new Date(startTime).getTime() + (summary.elapsedTime || 0) * 1000).toISOString()

  const distanceM = options.distanceM != null ? Math.max(0, Number(options.distanceM)) : (summary.totalDistance || 0)
  const movingTimeMs = Math.round((summary.movingTime || 0) * 1000)
  const elapsedTimeMs = Math.round((summary.elapsedTime || 0) * 1000)
  const durationMs = options.durationMs != null
    ? Math.max(0, Number(options.durationMs))
    : (movingTimeMs > 0 ? movingTimeMs : elapsedTimeMs)

  const avgPaceSecKm = distanceM > 0 && durationMs > 0 ? durationMs / distanceM : null
  const avgSpeedKmh = distanceM > 0 && durationMs > 0 ? (distanceM * 3600) / durationMs : null
  const elevationGainM = options.elevationGainM != null ? Math.max(0, Number(options.elevationGainM)) : (summary.elevationGain || 0)
  const calories = options.calories != null ? Math.max(0, Number(options.calories)) : (summary.calories || 0)

  // Track file path: <year>/<id>.json
  const startDate = new Date(startTime)
  const year = isNaN(startDate.getTime()) ? new Date().getUTCFullYear() : startDate.getUTCFullYear()
  const trackPath = `${year}/${id}.json`

  const trackData = {
    id,
    type,
    name,
    startTime,
    endTime,
    points: parsed.points,
    splits: summary.splits || [],
    summary: {
      distanceM,
      movingTimeMs: durationMs,
      elapsedTimeMs,
      avgPace: avgPaceSecKm,
      avgSpeed: avgSpeedKmh,
      elevationGainM,
      calories
    }
  }

  const adapter = options.adapter || getCardioAdapter()
  if (adapter && typeof adapter.writeTrack === 'function') {
    await adapter.writeTrack(trackPath, trackData)
  }

  const activity = {
    id,
    type,
    name,
    startTime,
    durationMs,
    distanceM,
    elevationGainM,
    avgPaceSecKm: avgPaceSecKm != null && isFinite(avgPaceSecKm) ? avgPaceSecKm : null,
    avgSpeedKmh: avgSpeedKmh != null && isFinite(avgSpeedKmh) ? avgSpeedKmh : null,
    calories,
    notes,
    trackPath,
    gearId: options.gearId || null,
    rpe: options.rpe != null ? Math.min(10, Math.max(1, Number(options.rpe))) : null
  }

  const store = options.store || useStore
  if (store && typeof store.getState === 'function') {
    store.getState().update(s => {
      if (!Array.isArray(s.cardioActivities)) s.cardioActivities = []
      s.cardioActivities.push(activity)
    })
  }

  return {
    activity,
    trackPath,
    trackData,
    summary
  }
}

/**
 * Imports a GPX track or route as a saved route.
 * Writes the routes/<id>.json track file to the cardio adapter and updates state.routes.
 *
 * @param {string|Blob|File|Object} input - GPX XML string, file, or pre-parsed object
 * @param {Object} [options={}] - Import options
 * @param {string} [options.id] - Custom route ID
 * @param {string} [options.name] - Custom route name override
 * @param {string} [options.desc] - Custom route description override
 * @param {string} [options.trackPath] - Custom track file path override
 * @param {Object} [options.adapter] - Cardio adapter override
 * @param {Object} [options.store] - Store override
 * @returns {Promise<{ route: Object, trackPath: string, routeData: Object, summary: Object }>}
 */
export async function importGPXAsRoute(input, options = {}) {
  let parsed = null

  if (input && typeof input === 'object' && Array.isArray(input.points)) {
    parsed = {
      name: input.name || '',
      desc: input.desc || '',
      creator: input.creator || 'OpenGym',
      points: input.points,
      summary: input.summary || summarizeTrackPoints(input.points)
    }
  } else {
    parsed = await parseGPXInput(input)
  }

  if (!parsed.points || parsed.points.length === 0) {
    throw new Error('GPX contains no GPS trackpoints')
  }

  const summary = parsed.summary || summarizeTrackPoints(parsed.points)
  const id = options.id || uid()
  const name = options.name || parsed.name || 'Imported Route'
  const desc = options.desc !== undefined ? options.desc : (options.notes || parsed.desc || '')
  const distanceM = options.distanceM != null ? Math.max(0, Number(options.distanceM)) : (summary.totalDistance || 0)
  const elevationGainM = options.elevationGainM != null ? Math.max(0, Number(options.elevationGainM)) : (summary.elevationGain || 0)
  const trackPath = options.trackPath || `routes/${id}.json`
  const createdAt = new Date().toISOString()

  const routeData = {
    id,
    name,
    desc,
    type: 'route',
    distanceM,
    elevationGainM,
    points: parsed.points,
    createdAt
  }

  const adapter = options.adapter || getCardioAdapter()
  if (adapter && typeof adapter.writeTrack === 'function') {
    await adapter.writeTrack(trackPath, routeData)
  }

  const route = {
    id,
    name,
    desc,
    type: 'route',
    distanceM,
    elevationGainM,
    trackPath,
    pointCount: parsed.points.length,
    createdAt
  }

  const store = options.store || useStore
  if (store && typeof store.getState === 'function') {
    store.getState().update(s => {
      if (!Array.isArray(s.routes)) s.routes = []
      s.routes.push(route)
      if (!Array.isArray(s.savedRoutes)) s.savedRoutes = []
      s.savedRoutes.push(route)
    })
  }

  return {
    route,
    trackPath,
    routeData,
    summary
  }
}

/**
 * Universal GPX import dispatcher.
 *
 * @param {string|Blob|File|Object} input - GPX input
 * @param {'activity'|'route'|'saved-route'} [destination='activity'] - Destination target
 * @param {Object} [options={}] - Options passed to importer
 * @returns {Promise<Object>} Result from importGPXAsActivity or importGPXAsRoute
 */
export async function importGPX(input, destination = 'activity', options = {}) {
  const norm = String(destination || '').toLowerCase()
  if (norm === 'route' || norm === 'savedroute' || norm === 'saved-route') {
    return importGPXAsRoute(input, options)
  }
  return importGPXAsActivity(input, options)
}
