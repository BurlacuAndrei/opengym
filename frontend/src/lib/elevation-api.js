// Standalone Open-Meteo DEM elevation lookup client (Issue #67).
// Fetches digital elevation model (DEM) altitudes from api.open-meteo.com,
// strictly gated behind user informed-consent in profile state.
// Batches points into URL-safe chunks, replaces/smooths track elevations,
// and computes elevation gain & loss profiles.

import { hasConsent as baseHasConsent } from './privacy.js'
import {
  getPointLat,
  getPointLon,
  getPointEle,
  smoothElevation,
  computeElevationGain,
  DEFAULT_ELEVATION_WINDOW,
  DEFAULT_ELEVATION_THRESHOLD
} from './track-math.js'

export const OPEN_METEO_ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation'
export const DEFAULT_CHUNK_SIZE = 100
export const ELEVATION_FEATURE_ID = 'elevation_lookup'

/**
 * Error thrown when DEM elevation lookup is attempted without user consent.
 */
export class ElevationConsentError extends Error {
  constructor(message = 'Consent required for elevation lookup') {
    super(message)
    this.name = 'ElevationConsentError'
    this.code = 'ERR_CONSENT_REQUIRED'
  }
}

/**
 * Error thrown when the external DEM elevation API returns an error or fails.
 */
export class ElevationApiError extends Error {
  constructor(message, status = null, details = null) {
    super(message)
    this.name = 'ElevationApiError'
    this.status = status
    this.details = details
  }
}

/**
 * Checks whether user has active consent for DEM elevation lookup.
 * Supports flexible argument patterns:
 *   hasConsent('elevation_lookup', state)
 *   hasConsent(state, 'elevation_lookup')
 *   hasConsent(state) -> defaults feature to 'elevation_lookup'
 *   hasConsent('elevation_lookup') -> delegates to store via privacy.js
 */
export function hasConsent(a, b) {
  if (typeof a === 'string' && b && typeof b === 'object') {
    return baseHasConsent(b, a)
  }
  if (typeof a === 'object' && typeof b === 'string') {
    return baseHasConsent(a, b)
  }
  if (typeof a === 'object' && !b) {
    return baseHasConsent(a, ELEVATION_FEATURE_ID)
  }
  return baseHasConsent(a, b || ELEVATION_FEATURE_ID)
}

/**
 * Convenience helper for checking elevation consent on state.
 */
export function hasElevationConsent(state) {
  return hasConsent(ELEVATION_FEATURE_ID, state)
}

/**
 * Slices an array into smaller chunks of at most `size` elements.
 */
export function chunkArray(arr, size) {
  if (!Array.isArray(arr) || size <= 0) return []
  const chunks = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

/**
 * Builds an Open-Meteo elevation URL for coordinate pairs.
 */
export function buildElevationUrl(coords, endpoint = OPEN_METEO_ELEVATION_URL) {
  const url = new URL(endpoint)
  const lats = []
  const lons = []

  for (const c of coords) {
    // Round to 6 decimal places (~0.1m precision) to keep URLs compact and URL-safe
    lats.push(Number(c.lat.toFixed(6)))
    lons.push(Number(c.lon.toFixed(6)))
  }

  url.searchParams.set('latitude', lats.join(','))
  url.searchParams.set('longitude', lons.join(','))
  return url.toString()
}

/**
 * Fetches DEM elevations from Open-Meteo for an array of coordinates or points.
 * Chunks coordinates into URL-safe batches (default 100 points per request).
 *
 * @param {Array<Object|Array>} coordinates - Array of {lat, lon} or track points
 * @param {Object} [options={}]
 * @param {Object} [options.state] - State to check for 'elevation_lookup' consent
 * @param {boolean} [options.skipConsentCheck=false] - Skip consent check if pre-verified
 * @param {string} [options.endpoint=OPEN_METEO_ELEVATION_URL] - Base API URL
 * @param {number} [options.chunkSize=DEFAULT_CHUNK_SIZE] - Max points per batch
 * @param {Function} [options.fetch=globalThis.fetch] - Custom fetch implementation
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @returns {Promise<Array<number|null>>} Array of elevation values in meters
 */
export async function fetchElevations(coordinates, options = {}) {
  const {
    state,
    skipConsentCheck = false,
    endpoint = OPEN_METEO_ELEVATION_URL,
    chunkSize = DEFAULT_CHUNK_SIZE,
    fetch: customFetch = globalThis.fetch,
    signal,
  } = options

  if (!skipConsentCheck && !hasConsent(ELEVATION_FEATURE_ID, state)) {
    throw new ElevationConsentError(
      'Cannot fetch elevation: Privacy consent for "elevation_lookup" is not granted.'
    )
  }

  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return []
  }

  // Map input coordinates to valid lat/lon, keeping track of original indices
  const validItems = []
  for (let i = 0; i < coordinates.length; i++) {
    const pt = coordinates[i]
    const lat = getPointLat(pt)
    const lon = getPointLon(pt)
    if (lat != null && lon != null) {
      validItems.push({ index: i, lat, lon })
    }
  }

  const results = new Array(coordinates.length).fill(null)
  if (validItems.length === 0) {
    return results
  }

  // Chunk valid coordinates into URL-safe batches
  const batches = chunkArray(validItems, Math.max(1, chunkSize))

  for (const batch of batches) {
    const url = buildElevationUrl(batch, endpoint)

    let response
    try {
      response = await customFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal
      })
    } catch (err) {
      if (err.name === 'AbortError') throw err
      throw new ElevationApiError(
        `Open-Meteo elevation network request failed: ${err.message}`,
        null,
        err
      )
    }

    if (!response.ok) {
      let bodyText = ''
      try {
        bodyText = await response.text()
      } catch {
        // ignore body read error
      }
      throw new ElevationApiError(
        `Open-Meteo elevation request returned HTTP ${response.status}: ${bodyText || response.statusText}`,
        response.status,
        bodyText
      )
    }

    let data
    try {
      data = await response.json()
    } catch (err) {
      throw new ElevationApiError(`Invalid JSON from elevation API: ${err.message}`, response.status, err)
    }

    if (!data || !Array.isArray(data.elevation)) {
      throw new ElevationApiError('Open-Meteo response missing "elevation" array', response.status, data)
    }

    const elevations = data.elevation
    for (let j = 0; j < batch.length; j++) {
      const originalIdx = batch[j].index
      const ele = elevations[j]
      results[originalIdx] = (typeof ele === 'number' && Number.isFinite(ele)) ? ele : null
    }
  }

  return results
}

/**
 * Enriches track points with Open-Meteo DEM elevation data.
 * Checks privacy consent, fetches altitudes in URL-safe batches, replaces track elevations,
 * optionally applies windowed elevation smoothing, and computes elevation gain & loss.
 *
 * @param {Array<Object>|Object} trackOrPoints - Track object { points: [...] } or array of points
 * @param {Object} [options={}]
 * @param {Object} [options.state] - State to verify consent
 * @param {boolean} [options.smooth=true] - Whether to smooth elevations
 * @param {Object} [options.smoothOptions] - Options passed to smoothElevation
 * @param {boolean} [options.calculateStats=true] - Whether to compute gain/loss stats
 * @param {Object} [options.gainOptions] - Options passed to computeElevationGain
 * @param {string} [options.fallback='throw'] - 'throw' or 'original' on API failure
 * @param {boolean} [options.preserveOriginal=false] - Keep original elevation in originalEle
 * @returns {Promise<Object>} { points, stats, gain, loss, elevations, ...trackMeta }
 */
export async function enrichTrackElevation(trackOrPoints, options = {}) {
  const isTrackObj = typeof trackOrPoints === 'object' && trackOrPoints !== null && !Array.isArray(trackOrPoints)
  const rawPoints = isTrackObj ? (trackOrPoints.points || []) : (Array.isArray(trackOrPoints) ? trackOrPoints : [])

  const {
    state,
    smooth = true,
    smoothOptions = { windowSize: DEFAULT_ELEVATION_WINDOW },
    calculateStats = true,
    gainOptions = { threshold: DEFAULT_ELEVATION_THRESHOLD },
    fallback = 'throw',
    preserveOriginal = false,
    ...fetchOpts
  } = options

  if (rawPoints.length === 0) {
    const emptyStats = { gain: 0, loss: 0, min: null, max: null }
    const result = {
      points: [],
      stats: emptyStats,
      gain: 0,
      loss: 0,
      elevations: []
    }
    return isTrackObj ? { ...trackOrPoints, ...result } : result
  }

  let elevations
  try {
    elevations = await fetchElevations(rawPoints, { state, ...fetchOpts })
  } catch (err) {
    if (fallback === 'original') {
      // Gracefully fall back to existing track elevations
      const stats = calculateStats
        ? computeElevationGain(rawPoints, { smooth, ...gainOptions, ...smoothOptions })
        : { gain: 0, loss: 0, min: null, max: null }
      const fallbackResult = {
        points: rawPoints,
        stats,
        gain: stats.gain,
        loss: stats.loss,
        elevations: rawPoints.map(getPointEle),
        error: err
      }
      return isTrackObj ? { ...trackOrPoints, ...fallbackResult } : fallbackResult
    }
    throw err
  }

  // Clone points and inject DEM elevation
  const enrichedPoints = rawPoints.map((pt, idx) => {
    const demEle = elevations[idx]
    if (Array.isArray(pt)) {
      const cloned = [...pt]
      if (demEle != null) {
        cloned[2] = demEle
      }
      return cloned
    }

    if (typeof pt === 'object' && pt !== null) {
      const cloned = { ...pt }
      if (preserveOriginal) {
        cloned.originalEle = getPointEle(pt)
      }
      if (demEle != null) {
        cloned.ele = demEle
        if (cloned.alt !== undefined) cloned.alt = demEle
        if (cloned.elevation !== undefined) cloned.elevation = demEle
      }
      return cloned
    }

    return pt
  })

  // Apply smoothing if enabled
  const finalPoints = smooth ? smoothElevation(enrichedPoints, smoothOptions) : enrichedPoints

  // Compute elevation stats (gain/loss/min/max)
  let stats = { gain: 0, loss: 0, min: null, max: null }
  if (calculateStats) {
    // If already smoothed above, compute gain directly without double smoothing
    stats = computeElevationGain(finalPoints, { smooth: false, ...gainOptions })
  }

  const result = {
    points: finalPoints,
    stats,
    gain: stats.gain,
    loss: stats.loss,
    elevations
  }

  if (isTrackObj) {
    return {
      ...trackOrPoints,
      ...result,
      elevationGainM: stats.gain,
      elevationLossM: stats.loss
    }
  }

  return result
}

// Aliases for convenience
export const lookupTrackElevation = enrichTrackElevation
export const enhanceTrackElevation = enrichTrackElevation

/**
 * Creates a mock `fetch` implementation for offline mode and tests.
 *
 * @param {Object|Function|Array<number>|number} config
 *   - Function: `(lat, lon, index) => elevation`
 *   - Array<number>: Fixed sequence of elevations
 *   - number: Constant elevation for all points
 *   - Object: { handler, status, error, delayMs }
 * @returns {Function} mock fetch compatible with fetchElevations
 */
export function createMockElevationFetch(config = {}) {
  return async function mockFetch(url, init = {}) {
    if (init.signal?.aborted) {
      const err = new Error('The operation was aborted.')
      err.name = 'AbortError'
      throw err
    }

    const parsedUrl = new URL(url)
    const latParam = parsedUrl.searchParams.get('latitude') || ''
    const lonParam = parsedUrl.searchParams.get('longitude') || ''

    const lats = latParam ? latParam.split(',').map(Number) : []
    const lons = lonParam ? lonParam.split(',').map(Number) : []

    // Check for simulated delay
    if (typeof config === 'object' && config?.delayMs > 0) {
      await new Promise(r => setTimeout(r, config.delayMs))
    }

    // Check for simulated network error
    if (typeof config === 'object' && config?.networkError) {
      throw new Error(typeof config.networkError === 'string' ? config.networkError : 'Failed to fetch')
    }

    // Check for simulated HTTP error status
    if (typeof config === 'object' && config?.status && config.status !== 200) {
      return {
        ok: false,
        status: config.status,
        statusText: config.statusText || 'Error',
        text: async () => config.body || `HTTP error ${config.status}`,
        json: async () => { throw new Error('Not JSON') }
      }
    }

    const count = Math.min(lats.length, lons.length)
    let elevations = []

    if (typeof config === 'function') {
      for (let i = 0; i < count; i++) {
        elevations.push(config(lats[i], lons[i], i))
      }
    } else if (Array.isArray(config)) {
      elevations = config.slice(0, count)
    } else if (typeof config === 'number') {
      elevations = new Array(count).fill(config)
    } else if (typeof config === 'object' && config?.handler) {
      for (let i = 0; i < count; i++) {
        elevations.push(config.handler(lats[i], lons[i], i))
      }
    } else if (typeof config === 'object' && Array.isArray(config?.elevations)) {
      elevations = config.elevations.slice(0, count)
    } else {
      // Default: synthetic deterministic elevation based on lat/lon
      for (let i = 0; i < count; i++) {
        const val = Math.round(Math.abs(Math.sin(lats[i] * 10) + Math.cos(lons[i] * 10)) * 200 * 10) / 10
        elevations.push(val)
      }
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ elevation: elevations }),
      json: async () => ({ elevation: elevations })
    }
  }
}
