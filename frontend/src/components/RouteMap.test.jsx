import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import RouteMap, {
  hasConsent,
  OSM_FEATURE_ID,
  DEFAULT_TILE_URL,
  DEFAULT_ATTRIBUTION,
  DEFAULT_PROMPT,
  latToY,
  lonToX,
  calculateZoom,
  getVisibleTiles,
  projectPointsToScreen,
  initLeafletMap,
} from './RouteMap.jsx'
import { grantConsent, revokeConsent } from '../lib/privacy.js'

describe('RouteMap - Opt-in Leaflet + OpenStreetMap Tile Layer (Issue #74)', () => {
  const samplePoints = [
    { lat: 52.5200, lon: 13.4050 },
    { lat: 52.5210, lon: 13.4060 },
    { lat: 52.5220, lon: 13.4070 },
    { lat: 52.5230, lon: 13.4080 },
  ]

  const consentedState = {
    privacy: {
      consents: {
        osm_tiles: {
          agreedAt: '2026-11-12T00:00:00.000Z',
          revokedAt: null,
          version: 1,
        },
      },
    },
  }

  const revokedState = {
    privacy: {
      consents: {
        osm_tiles: {
          agreedAt: null,
          revokedAt: '2026-11-12T01:00:00.000Z',
          version: 1,
        },
      },
    },
  }

  const unconsentedState = {
    privacy: {
      consents: {},
    },
  }

  // -------------------------------------------------------------------------
  // 1. Consent Gating Logic
  // -------------------------------------------------------------------------
  describe('1. hasConsent Gating Pure Function', () => {
    it('returns true when consent is granted and active', () => {
      expect(hasConsent('osm_tiles', consentedState)).toBe(true)
      expect(hasConsent(consentedState, 'osm_tiles')).toBe(true)
      expect(hasConsent(consentedState)).toBe(true)
    })

    it('returns false when consent is revoked', () => {
      expect(hasConsent('osm_tiles', revokedState)).toBe(false)
      expect(hasConsent(revokedState, 'osm_tiles')).toBe(false)
      expect(hasConsent(revokedState)).toBe(false)
    })

    it('returns false when consent is missing or uninitialized', () => {
      expect(hasConsent('osm_tiles', unconsentedState)).toBe(false)
      expect(hasConsent('osm_tiles', {})).toBe(false)
      expect(hasConsent('osm_tiles', null)).toBe(false)
      expect(hasConsent('osm_tiles', undefined)).toBe(false)
    })

    it('works correctly with grantConsent and revokeConsent helpers', () => {
      const state = {}
      expect(hasConsent('osm_tiles', state)).toBe(false)

      grantConsent(state, OSM_FEATURE_ID)
      expect(hasConsent('osm_tiles', state)).toBe(true)

      revokeConsent(state, OSM_FEATURE_ID)
      expect(hasConsent('osm_tiles', state)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // 2. Fallback Rendering & Zero Network Calls when Consent is Absent
  // -------------------------------------------------------------------------
  describe('2. Fallback Rendering & Zero Network Calls (Consent Absent)', () => {
    it('renders zero-network RouteCanvas when consent is not granted', () => {
      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: samplePoints,
          state: unconsentedState,
          width: 320,
          height: 200,
        })
      )

      // Renders offline RouteCanvas fallback
      expect(html).toContain('data-testid="route-canvas"')
      expect(html).toContain('<canvas')

      // Renders the Privacy consent prompt
      expect(html).toContain('data-testid="route-map-privacy-prompt"')
      expect(html).toContain('Enable map tiles in Privacy settings')

      // Strictly ZERO network calls or tile references
      expect(html).not.toContain('tile.openstreetmap.org')
      expect(html).not.toContain('osm-tile')
      expect(html).not.toContain('<img')
    })

    it('renders fallback when state is null or empty', () => {
      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: samplePoints,
          state: null,
        })
      )

      expect(html).toContain('data-testid="route-canvas"')
      expect(html).toContain('Enable map tiles in Privacy settings')
      expect(html).not.toContain('tile.openstreetmap.org')
    })

    it('renders fallback when consent has been revoked', () => {
      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: samplePoints,
          state: revokedState,
        })
      )

      expect(html).toContain('data-testid="route-canvas"')
      expect(html).toContain('Enable map tiles in Privacy settings')
      expect(html).not.toContain('tile.openstreetmap.org')
    })

    it('renders interactive button when onEnablePrivacy callback is provided', () => {
      const onEnablePrivacy = vi.fn()
      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: samplePoints,
          state: unconsentedState,
          onEnablePrivacy,
        })
      )

      expect(html).toContain('data-testid="route-map-privacy-btn"')
      expect(html).toContain('<button')
      expect(html).toContain('Enable map tiles in Privacy settings')
    })
  })

  // -------------------------------------------------------------------------
  // 3. Offline Gating (Falls back to RouteCanvas even if consented)
  // -------------------------------------------------------------------------
  describe('3. Offline Gating & Fallback', () => {
    it('falls back to RouteCanvas and privacy prompt when offline={true}', () => {
      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: samplePoints,
          state: consentedState,
          offline: true,
        })
      )

      // Falls back to RouteCanvas
      expect(html).toContain('data-testid="route-canvas"')
      expect(html).toContain('Enable map tiles in Privacy settings')

      // Zero network calls
      expect(html).not.toContain('tile.openstreetmap.org')
      expect(html).not.toContain('<img')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Consented Lightweight OSM Tile Layer Rendering
  // -------------------------------------------------------------------------
  describe('4. Consented OSM Tile Layer Rendering', () => {
    it('renders OSM tile layer with img tags and attribution when consented', () => {
      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: samplePoints,
          state: consentedState,
          width: 320,
          height: 200,
        })
      )

      // Does NOT render offline canvas fallback or privacy prompt
      expect(html).not.toContain('data-testid="route-canvas"')
      expect(html).not.toContain('Enable map tiles in Privacy settings')

      // Renders tile layer and images
      expect(html).toContain('data-testid="osm-tile-layer"')
      expect(html).toContain('data-testid="osm-tile"')
      expect(html).toContain('https://tile.openstreetmap.org/')

      // Renders attribution
      expect(html).toContain('data-testid="osm-attribution"')
      expect(html).toContain('© OpenStreetMap contributors')

      // Renders SVG route polyline and dots
      expect(html).toContain('data-testid="route-map-svg"')
      expect(html).toContain('data-testid="route-map-polyline"')
      expect(html).toContain('data-testid="route-map-start-dot"')
      expect(html).toContain('data-testid="route-map-end-dot"')
    })

    it('supports custom tileServerUrl and attribution', () => {
      const customUrl = 'https://custom-tiles.example.com/{z}/{x}/{y}.png'
      const customAttribution = 'Map data © Custom Corp'

      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: samplePoints,
          state: consentedState,
          tileServerUrl: customUrl,
          attribution: customAttribution,
        })
      )

      expect(html).toContain('https://custom-tiles.example.com/')
      expect(html).toContain('Map data © Custom Corp')
    })
  })

  // -------------------------------------------------------------------------
  // 5. Projection & Web Mercator Pure Helpers
  // -------------------------------------------------------------------------
  describe('5. Web Mercator & Geometry Helpers', () => {
    it('latToY and lonToX compute correct projection fractions', () => {
      // At zoom 0, world is 1x1 tile unit
      expect(latToY(0, 0)).toBeCloseTo(0.5, 4)
      expect(lonToX(0, 0)).toBeCloseTo(0.5, 4)

      // lon -180 should be 0, lon +180 should be 2^zoom
      expect(lonToX(-180, 5)).toBeCloseTo(0, 4)
      expect(lonToX(180, 5)).toBeCloseTo(32, 4)
    })

    it('calculateZoom returns integer in [1, 18]', () => {
      const zoomDefault = calculateZoom(null)
      expect(zoomDefault).toBe(13)

      const bounds = { minLat: 52.50, maxLat: 52.54, minLon: 13.38, maxLon: 13.43, count: 20 }
      const z = calculateZoom(bounds, 300, 200)
      expect(z).toBeGreaterThanOrEqual(1)
      expect(z).toBeLessThanOrEqual(18)
    })

    it('getVisibleTiles produces valid tile objects with correct URLs', () => {
      const tiles = getVisibleTiles({
        centerLat: 52.52,
        centerLon: 13.405,
        zoom: 13,
        width: 300,
        height: 200,
      })

      expect(tiles.length).toBeGreaterThan(0)
      for (const tile of tiles) {
        expect(tile.url).toMatch(/https:\/\/tile\.openstreetmap\.org\/13\/\d+\/\d+\.png/)
        expect(tile.z).toBe(13)
        expect(typeof tile.left).toBe('number')
        expect(typeof tile.top).toBe('number')
      }
    })

    it('projectPointsToScreen maps coordinates to viewport pixel space', () => {
      const screenPoints = projectPointsToScreen(samplePoints, 52.52, 13.405, 13, 300, 200)
      expect(screenPoints).toHaveLength(samplePoints.length)
      for (const p of screenPoints) {
        expect(typeof p.x).toBe('number')
        expect(typeof p.y).toBe('number')
      }
    })

    it('projectPointsToScreen handles null, empty or invalid points gracefully', () => {
      expect(projectPointsToScreen([], 52.52, 13.405, 13, 300, 200)).toEqual([])
      expect(projectPointsToScreen(null, 52.52, 13.405, 13, 300, 200)).toEqual([])
      const invalid = [{ lat: 'invalid', lon: 10 }, null]
      expect(projectPointsToScreen(invalid, 52.52, 13.405, 13, 300, 200)).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // 6. Leaflet Map Integration (initLeafletMap)
  // -------------------------------------------------------------------------
  describe('6. Leaflet Map Integration & Lifecycle', () => {
    it('initializes map, tileLayer, polyline, markers and cleans up on unmount', () => {
      const mockMap = {
        setView: vi.fn().mockReturnThis(),
        fitBounds: vi.fn().mockReturnThis(),
        remove: vi.fn(),
      }

      const mockTileLayerInstance = {
        addTo: vi.fn().mockReturnThis(),
      }

      const mockPolylineInstance = {
        addTo: vi.fn().mockReturnThis(),
      }

      const mockMarkerInstance = {
        addTo: vi.fn().mockReturnThis(),
      }

      const mockLeaflet = {
        map: vi.fn().mockReturnValue(mockMap),
        tileLayer: vi.fn().mockReturnValue(mockTileLayerInstance),
        polyline: vi.fn().mockReturnValue(mockPolylineInstance),
        circleMarker: vi.fn().mockReturnValue(mockMarkerInstance),
      }

      const container = {}

      const cleanup = initLeafletMap(container, {
        leaflet: mockLeaflet,
        points: samplePoints,
        strokeColor: '#3b82f6',
        lineWidth: 4,
        startColor: '#22c55e',
        endColor: '#ef4444',
      })

      // 1. Map creation
      expect(mockLeaflet.map).toHaveBeenCalledWith(container, expect.objectContaining({
        attributionControl: true,
      }))

      // 2. Tile layer attached
      expect(mockLeaflet.tileLayer).toHaveBeenCalledWith(
        DEFAULT_TILE_URL,
        expect.objectContaining({ attribution: DEFAULT_ATTRIBUTION })
      )
      expect(mockTileLayerInstance.addTo).toHaveBeenCalledWith(mockMap)

      // 3. Polyline added with coordinates
      expect(mockLeaflet.polyline).toHaveBeenCalledWith(
        expect.arrayContaining([[52.52, 13.405]]),
        expect.objectContaining({ color: '#3b82f6', weight: 4 })
      )
      expect(mockPolylineInstance.addTo).toHaveBeenCalledWith(mockMap)

      // 4. Start & End circleMarkers
      expect(mockLeaflet.circleMarker).toHaveBeenCalledTimes(2)
      expect(mockMarkerInstance.addTo).toHaveBeenCalledWith(mockMap)

      // 5. Bounds fitted
      expect(mockMap.fitBounds).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ padding: [16, 16] })
      )

      // 6. Cleanup removes map
      cleanup()
      expect(mockMap.remove).toHaveBeenCalled()
    })

    it('returns null if leaflet or container is missing', () => {
      expect(initLeafletMap(null, { leaflet: {} })).toBeNull()
      expect(initLeafletMap({}, { leaflet: null })).toBeNull()
    })

    it('handles single point tracks by setting map view instead of fitBounds', () => {
      const mockMap = {
        setView: vi.fn().mockReturnThis(),
        fitBounds: vi.fn().mockReturnThis(),
        remove: vi.fn(),
      }
      const mockMarker = { addTo: vi.fn().mockReturnThis() }
      const mockTileLayer = { addTo: vi.fn().mockReturnThis() }

      const mockLeaflet = {
        map: vi.fn().mockReturnValue(mockMap),
        tileLayer: vi.fn().mockReturnValue(mockTileLayer),
        circleMarker: vi.fn().mockReturnValue(mockMarker),
      }

      initLeafletMap({}, {
        leaflet: mockLeaflet,
        points: [{ lat: 52.52, lon: 13.405 }],
      })

      expect(mockMap.setView).toHaveBeenCalledWith([52.52, 13.405], 14)
      expect(mockMap.fitBounds).not.toHaveBeenCalled()
    })

    it('renders Leaflet container wrapper when leafletLib is provided and consented', () => {
      const mockLeaflet = {
        map: vi.fn().mockReturnValue({ setView: vi.fn(), remove: vi.fn() }),
        tileLayer: vi.fn().mockReturnValue({ addTo: vi.fn() }),
      }

      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: samplePoints,
          state: consentedState,
          leafletLib: mockLeaflet,
        })
      )

      expect(html).toContain('data-testid="route-map-leaflet"')
      expect(html).not.toContain('Enable map tiles in Privacy settings')
      expect(html).not.toContain('data-testid="route-canvas"')
    })
  })

  // -------------------------------------------------------------------------
  // 7. Coordinate Formats & Edge Cases
  // -------------------------------------------------------------------------
  describe('7. Coordinate Shapes & Edge Cases', () => {
    it('handles point tuples [lat, lon]', () => {
      const tuplePoints = [
        [52.52, 13.405],
        [52.521, 13.406],
      ]

      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: tuplePoints,
          state: consentedState,
        })
      )

      expect(html).toContain('data-testid="osm-tile-layer"')
      expect(html).toContain('data-testid="route-map-polyline"')
    })

    it('handles point objects with latitude/longitude keys', () => {
      const altPoints = [
        { latitude: 52.52, longitude: 13.405 },
        { latitude: 52.521, longitude: 13.406 },
      ]

      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: altPoints,
          state: consentedState,
        })
      )

      expect(html).toContain('data-testid="osm-tile-layer"')
      expect(html).toContain('data-testid="route-map-polyline"')
    })

    it('handles empty points array gracefully without crashing', () => {
      const htmlFallback = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: [],
          state: unconsentedState,
        })
      )
      expect(htmlFallback).toContain('data-testid="route-canvas"')

      const htmlConsented = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: [],
          state: consentedState,
        })
      )
      expect(htmlConsented).toContain('data-testid="osm-tile-layer"')
    })
  })
})
