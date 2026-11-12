import React, { useEffect, useRef } from 'react'
import RouteCanvas, { getCoord, getRouteBounds } from './RouteCanvas.jsx'
import { hasConsent as baseHasConsent } from '../lib/privacy.js'
import { useStore } from '../store/useStore.js'

export const OSM_FEATURE_ID = 'osm_tiles'
export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const DEFAULT_ATTRIBUTION = '© OpenStreetMap contributors'
export const DEFAULT_PROMPT = 'Enable map tiles in Privacy settings'

/**
 * Checks whether user has active consent for OpenStreetMap tile fetching.
 * Supports flexible argument patterns:
 *   hasConsent('osm_tiles', state)
 *   hasConsent(state, 'osm_tiles')
 *   hasConsent(state) -> defaults feature to 'osm_tiles'
 *   hasConsent('osm_tiles') -> delegates to store via privacy.js
 */
export function hasConsent(a, b) {
  if (typeof a === 'string') {
    if (arguments.length >= 2) {
      if (!b || typeof b !== 'object') return false
      return baseHasConsent(b, a)
    }
    return baseHasConsent(a)
  }

  if (typeof a === 'object') {
    if (!a) return false
    const featureId = typeof b === 'string' ? b : OSM_FEATURE_ID
    return baseHasConsent(a, featureId)
  }

  return false
}

/**
 * Web Mercator projection: projects latitude (degrees) to tile Y fractional unit.
 */
export function latToY(lat, zoom) {
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat))
  const latRad = (clampedLat * Math.PI) / 180
  const n = Math.pow(2, zoom)
  return ((1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2) * n
}

/**
 * Web Mercator projection: projects longitude (degrees) to tile X fractional unit.
 */
export function lonToX(lon, zoom) {
  const n = Math.pow(2, zoom)
  return ((lon + 180) / 360) * n
}

/**
 * Computes an appropriate zoom level to fit bounds within width & height with padding.
 */
export function calculateZoom(bounds, width = 300, height = 200, padding = 40) {
  if (!bounds || bounds.count === 0) return 13
  const latDiff = bounds.maxLat - bounds.minLat
  const lonDiff = bounds.maxLon - bounds.minLon
  if (latDiff <= 0.00001 && lonDiff <= 0.00001) return 14

  const usableW = Math.max(width - padding * 2, 60)
  const usableH = Math.max(height - padding * 2, 60)

  const dx0 = (lonDiff / 360) * 256
  const dy0 = Math.abs(latToY(bounds.minLat, 0) - latToY(bounds.maxLat, 0)) * 256

  const zx = dx0 > 0 ? Math.log2(usableW / dx0) : 18
  const zy = dy0 > 0 ? Math.log2(usableH / dy0) : 18

  const z = Math.floor(Math.min(zx, zy))
  return Math.max(1, Math.min(18, z))
}

/**
 * Calculates visible tile descriptors for a given center, zoom, and viewport dimensions.
 */
export function getVisibleTiles({
  centerLat,
  centerLon,
  zoom,
  width,
  height,
  tileServerUrl = DEFAULT_TILE_URL,
}) {
  const maxTile = Math.pow(2, zoom)
  const cx = lonToX(centerLon, zoom) * 256
  const cy = latToY(centerLat, zoom) * 256

  const minTx = Math.floor((cx - width / 2) / 256)
  const maxTx = Math.floor((cx + width / 2) / 256)
  const minTy = Math.floor((cy - height / 2) / 256)
  const maxTy = Math.floor((cy + height / 2) / 256)

  const tiles = []
  for (let ty = minTy; ty <= maxTy; ty++) {
    if (ty < 0 || ty >= maxTile) continue
    for (let tx = minTx; tx <= maxTx; tx++) {
      const normalizedTx = ((tx % maxTile) + maxTile) % maxTile
      const left = tx * 256 - (cx - width / 2)
      const top = ty * 256 - (cy - height / 2)
      const url = tileServerUrl
        .replace('{z}', String(zoom))
        .replace('{x}', String(normalizedTx))
        .replace('{y}', String(ty))

      tiles.push({
        x: normalizedTx,
        y: ty,
        z: zoom,
        left: Math.round(left * 10) / 10,
        top: Math.round(top * 10) / 10,
        url,
        key: `${zoom}-${normalizedTx}-${ty}`,
      })
    }
  }
  return tiles
}

/**
 * Projects track coordinates to 2D screen coordinates relative to container top-left.
 */
export function projectPointsToScreen(points, centerLat, centerLon, zoom, width, height) {
  if (!points || !points.length) return []
  const cx = lonToX(centerLon, zoom) * 256
  const cy = latToY(centerLat, zoom) * 256

  const screenPoints = []
  for (const p of points) {
    const c = getCoord(p)
    if (!c) continue
    const px = lonToX(c.lon, zoom) * 256 - (cx - width / 2)
    const py = latToY(c.lat, zoom) * 256 - (cy - height / 2)
    screenPoints.push({
      x: Math.round(px * 10) / 10,
      y: Math.round(py * 10) / 10,
      lat: c.lat,
      lon: c.lon,
    })
  }
  return screenPoints
}

/**
 * Initializes a Leaflet map instance on a container element.
 * Returns an unmount/cleanup function.
 */
export function initLeafletMap(container, options = {}) {
  const {
    leaflet,
    points = [],
    strokeColor = '#10b981',
    lineWidth = 3,
    startColor = '#22c55e',
    endColor = '#ef4444',
    dotRadius = 5,
    zoom = 14,
    padding = 16,
    tileServerUrl = DEFAULT_TILE_URL,
    attribution = DEFAULT_ATTRIBUTION,
  } = options

  if (!leaflet || !container) return null

  const validCoords = (points || []).map(getCoord).filter(Boolean)
  const map = leaflet.map(container, {
    attributionControl: true,
    zoomControl: false,
  })

  if (leaflet.tileLayer) {
    leaflet.tileLayer(tileServerUrl, {
      attribution,
      maxZoom: 19,
    }).addTo(map)
  }

  if (validCoords.length > 0) {
    const latLngs = validCoords.map(c => [c.lat, c.lon])
    if (latLngs.length > 1 && leaflet.polyline) {
      leaflet.polyline(latLngs, {
        color: strokeColor,
        weight: lineWidth,
      }).addTo(map)
    }

    if (leaflet.circleMarker) {
      if (latLngs.length >= 1) {
        leaflet.circleMarker(latLngs[0], {
          radius: dotRadius,
          color: startColor,
          fillColor: startColor,
          fillOpacity: 1,
        }).addTo(map)
      }
      if (latLngs.length > 1) {
        leaflet.circleMarker(latLngs[latLngs.length - 1], {
          radius: dotRadius,
          color: endColor,
          fillColor: endColor,
          fillOpacity: 1,
        }).addTo(map)
      }
    }

    if (latLngs.length > 1 && map.fitBounds) {
      map.fitBounds(latLngs, { padding: [padding, padding] })
    } else if (map.setView) {
      map.setView(latLngs[0], zoom)
    }
  } else if (map.setView) {
    map.setView([0, 0], zoom)
  }

  return () => {
    if (map && typeof map.remove === 'function') {
      map.remove()
    }
  }
}

/**
 * RouteMap Component (Issue #74)
 *
 * Opt-in map view rendering an OpenStreetMap tile layer (via Leaflet or lightweight tile viewer)
 * strictly gated behind user Privacy consent.
 *
 * Fallback behavior:
 * When consent is not granted OR when offline, falls back to zero-network RouteCanvas
 * and renders the "Enable map tiles in Privacy settings" prompt.
 */
export default function RouteMap({
  points = [],
  currentPosition = null,
  state,
  offline,
  width = 300,
  height = 200,
  padding = 16,
  strokeColor = '#10b981',
  lineWidth = 3,
  startColor = '#22c55e',
  endColor = '#ef4444',
  dotRadius = 5,
  zoom: userZoom,
  leafletLib,
  useLeaflet = false,
  tileServerUrl = DEFAULT_TILE_URL,
  attribution = DEFAULT_ATTRIBUTION,
  promptMessage = DEFAULT_PROMPT,
  onEnablePrivacy,
  className = 'route-map',
  style,
  dataTestId = 'route-map',
  ...props
}) {
  let storeS = null
  try {
    storeS = useStore ? useStore(s => s.S) : null
  } catch {
    storeS = null
  }

  const activeState = state !== undefined ? state : storeS
  const consented = Boolean(hasConsent(OSM_FEATURE_ID, activeState))

  const isOffline = Boolean(
    offline === true ||
    (offline === undefined && typeof navigator !== 'undefined' && navigator.onLine === false)
  )

  const showFallback = !consented || isOffline

  const mapContainerRef = useRef(null)
  const isLeafletAvailable = Boolean(leafletLib || (typeof window !== 'undefined' && window.L))
  const shouldUseLeaflet = !showFallback && (useLeaflet || leafletLib) && isLeafletAvailable

  useEffect(() => {
    if (!shouldUseLeaflet || !mapContainerRef.current) return
    const L = leafletLib || (typeof window !== 'undefined' ? window.L : null)
    if (!L) return

    const cleanup = initLeafletMap(mapContainerRef.current, {
      leaflet: L,
      points,
      width,
      height,
      padding,
      strokeColor,
      lineWidth,
      startColor,
      endColor,
      dotRadius,
      zoom: userZoom,
      tileServerUrl,
      attribution,
    })

    return () => {
      if (cleanup && typeof cleanup === 'function') cleanup()
    }
  }, [
    shouldUseLeaflet,
    leafletLib,
    points,
    width,
    height,
    padding,
    strokeColor,
    lineWidth,
    startColor,
    endColor,
    dotRadius,
    userZoom,
    tileServerUrl,
    attribution,
  ])

  // Fallback to RouteCanvas when consent is missing or device is offline
  if (showFallback) {
    return (
      <div
        className={`route-map-fallback ${className}`}
        style={{
          position: 'relative',
          width,
          display: 'inline-block',
          ...style,
        }}
        data-testid={dataTestId}
        data-fallback="true"
        data-consented={String(consented)}
        data-offline={String(isOffline)}
        {...props}
      >
        <RouteCanvas
          points={points}
          currentPosition={currentPosition}
          width={width}
          height={height}
          padding={padding}
          strokeColor={strokeColor}
          lineWidth={lineWidth}
          startColor={startColor}
          endColor={endColor}
          dotRadius={dotRadius}
        />
        <div
          className="route-map-privacy-prompt"
          data-testid="route-map-privacy-prompt"
          style={{
            marginTop: 6,
            fontSize: 12,
            color: 'var(--dim, #888)',
            textAlign: 'center',
          }}
        >
          {onEnablePrivacy ? (
            <button
              type="button"
              onClick={onEnablePrivacy}
              data-testid="route-map-privacy-btn"
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                textDecoration: 'underline',
                fontSize: 'inherit',
                fontFamily: 'inherit',
                padding: 0,
              }}
            >
              {promptMessage}
            </button>
          ) : (
            <span>{promptMessage}</span>
          )}
        </div>
      </div>
    )
  }

  // Leaflet-driven map view
  if (shouldUseLeaflet) {
    return (
      <div
        className={`route-map-leaflet-wrapper ${className}`}
        style={{
          position: 'relative',
          width,
          height,
          borderRadius: 8,
          overflow: 'hidden',
          display: 'inline-block',
          ...style,
        }}
        data-testid={dataTestId}
        data-leaflet="true"
        {...props}
      >
        <div
          ref={mapContainerRef}
          data-testid="route-map-leaflet"
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    )
  }

  // Lightweight OSM tile viewer
  const bounds = getRouteBounds(points)
  const centerLat = bounds ? (bounds.minLat + bounds.maxLat) / 2 : 52.52
  const centerLon = bounds ? (bounds.minLon + bounds.maxLon) / 2 : 13.405
  const zoom = userZoom || calculateZoom(bounds, width, height, padding)

  const tiles = getVisibleTiles({
    centerLat,
    centerLon,
    zoom,
    width,
    height,
    tileServerUrl,
  })

  const screenCoords = projectPointsToScreen(points, centerLat, centerLon, zoom, width, height)
  const hoverCoord = currentPosition ? getCoord(currentPosition) : null
  const hoverScreenCoords = hoverCoord
    ? projectPointsToScreen([hoverCoord], centerLat, centerLon, zoom, width, height)
    : []
  const hoverPointScreen = hoverScreenCoords.length > 0 ? hoverScreenCoords[0] : null

  return (
    <div
      className={`route-map-container ${className}`}
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: 8,
        overflow: 'hidden',
        display: 'inline-block',
        backgroundColor: '#e5e7eb',
        ...style,
      }}
      data-testid={dataTestId}
      data-osm-viewer="true"
      {...props}
    >
      <div
        className="osm-tiles"
        data-testid="osm-tile-layer"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        {tiles.map(tile => (
          <img
            key={tile.key}
            src={tile.url}
            alt=""
            data-testid="osm-tile"
            loading="lazy"
            style={{
              position: 'absolute',
              left: `${tile.left}px`,
              top: `${tile.top}px`,
              width: 256,
              height: 256,
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          />
        ))}
      </div>

      {screenCoords.length > 0 && (
        <svg
          data-testid="route-map-svg"
          width={width}
          height={height}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
          }}
        >
          {screenCoords.length > 1 && (
            <polyline
              data-testid="route-map-polyline"
              points={screenCoords.map(p => `${p.x},${p.y}`).join(' ')}
              stroke={strokeColor}
              strokeWidth={lineWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          )}
          {screenCoords.length >= 1 && (
            <circle
              data-testid="route-map-start-dot"
              cx={screenCoords[0].x}
              cy={screenCoords[0].y}
              r={dotRadius}
              fill={startColor}
            />
          )}
          {screenCoords.length > 1 && (
            <circle
              data-testid="route-map-end-dot"
              cx={screenCoords[screenCoords.length - 1].x}
              cy={screenCoords[screenCoords.length - 1].y}
              r={dotRadius}
              fill={endColor}
            />
          )}
          {hoverPointScreen && (
            <circle
              data-testid="route-map-cursor"
              cx={hoverPointScreen.x}
              cy={hoverPointScreen.y}
              r={(dotRadius || 5) + 2}
              fill="#3b82f6"
              stroke="#ffffff"
              strokeWidth={2}
            />
          )}
        </svg>
      )}

      <div
        className="osm-attribution"
        data-testid="osm-attribution"
        style={{
          position: 'absolute',
          bottom: 2,
          right: 4,
          fontSize: 10,
          lineHeight: '12px',
          background: 'rgba(255, 255, 255, 0.75)',
          color: '#333',
          padding: '1px 4px',
          borderRadius: 2,
          pointerEvents: 'auto',
        }}
      >
        {attribution}
      </div>
    </div>
  )
}
