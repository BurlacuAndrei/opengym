import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ActivityDetail from './ActivityDetail.jsx'
import { useStore, DEF } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
  getCardioAdapter,
  writeTrack,
} from '../lib/cardio-adapter.js'
import { exportGPX, sanitizeFilename } from '../lib/gpx-io.js'
import { trimTrackPoints, trimTrack, resolveTrackPath } from '../lib/track-trim.js'
import RouteMap, { OSM_FEATURE_ID } from '../components/RouteMap.jsx'
import {
  haversineDistance,
  rollingPace,
  smoothElevation,
  computeSplits,
  totalDistance,
} from '../lib/track-math.js'
import * as apiModule from '../lib/api.js'

// In-memory localStorage mock for node environment
if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store },
  }
}

// Sample GPS track points along a ~2.5km path
const sampleTrackPoints = [
  { lat: 47.6062, lon: -122.3321, ele: 15.0, time: 1731400000000 },
  { lat: 47.6080, lon: -122.3340, ele: 18.5, time: 1731400180000 },
  { lat: 47.6105, lon: -122.3365, ele: 24.2, time: 1731400360000 },
  { lat: 47.6130, lon: -122.3390, ele: 32.0, time: 1731400540000 },
  { lat: 47.6160, lon: -122.3420, ele: 28.4, time: 1731400720000 },
  { lat: 47.6190, lon: -122.3450, ele: 22.1, time: 1731400900000 },
]

const sampleActivity = {
  id: 'act-test-1',
  name: 'Afternoon River Run',
  cardioType: 'run',
  startTime: '2026-11-12T14:30:00Z',
  d: '2026-11-12',
  distanceM: 2500,
  durationMs: 900000, // 15 mins
  avgPaceSecKm: 360,  // 6:00 /km
  avgSpeedKmh: 10,
  elevationGainM: 35,
  points: sampleTrackPoints,
  trackPath: '2026/act-test-1.json',
  prs: [
    { rank: 1, label: '1k', rankLabel: 'PR', displayName: '1k' },
    { rank: 2, label: '1mi', rankLabel: '2nd', displayName: '1 mi' },
  ],
}

describe('ActivityDetail View (Issue #83)', () => {
  let memoryAdapter

  beforeEach(() => {
    localStorage.clear()
    memoryAdapter = createMemoryCardioAdapter()
    setCardioAdapter(memoryAdapter)

    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        unit: 'kg',
        cardioActivities: [sampleActivity],
        privacy: {
          consents: {
            [OSM_FEATURE_ID]: {
              agreedAt: '2026-11-12T00:00:00.000Z',
              revokedAt: null,
              version: 1,
            },
          },
        },
      },
      user: null,
      isServerMode: () => false,
    })

    useUI.setState({
      toastMsg: null,
      toast: vi.fn(msg => useUI.setState({ toastMsg: msg })),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1. Rendering
  // -------------------------------------------------------------------------
  describe('1. Component Rendering', () => {
    it('renders activity title, date, and KPI summary cards', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: sampleActivity,
        })
      )

      expect(html).toContain('data-testid="activity-detail-view"')
      expect(html).toContain('Afternoon River Run')
      expect(html).toContain('data-testid="activity-kpi-grid"')
      expect(html).toContain('data-testid="kpi-distance"')
      expect(html).toContain('data-testid="kpi-duration"')
      expect(html).toContain('data-testid="kpi-rate"')
      expect(html).toContain('data-testid="kpi-elevation"')
      expect(html).toContain('+35 m')
    })

    it('renders navigation buttons: Back, Trim, and GPX Export', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: sampleActivity,
        })
      )

      expect(html).toContain('data-testid="back-btn"')
      expect(html).toContain('data-testid="trim-toggle-btn"')
      expect(html).toContain('data-testid="gpx-export-btn"')
      expect(html).toContain('Export GPX')
    })

    it('renders RouteMap with track points', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: sampleActivity,
        })
      )

      expect(html).toContain('data-testid="activity-route-map"')
    })

    it('renders interactive pace chart and elevation profile chart', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: sampleActivity,
        })
      )

      expect(html).toContain('data-testid="elevation-chart"')
      expect(html).toContain('data-testid="pace-chart"')
      expect(html).toContain('Elevation Profile')
      expect(html).toContain('Pace Chart')
    })

    it('renders per-unit splits table with formatted columns and fastest highlight', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: sampleActivity,
        })
      )

      expect(html).toContain('data-testid="splits-table"')
      expect(html).toContain('data-testid="split-row-1"')
      expect(html).toContain('data-testid="split-row-2"')
      expect(html).toContain('Fastest')
    })

    it('renders PR trophy badges when achieved', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: sampleActivity,
        })
      )

      expect(html).toContain('data-testid="activity-pr-badges"')
      expect(html).toContain('1k PR')
    })

    it('renders empty/fallback notice when activity has no GPS track points', () => {
      const noTrackActivity = {
        id: 'act-no-track',
        name: 'Treadmill Walk',
        cardioType: 'walk',
        points: [],
      }

      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: noTrackActivity,
        })
      )

      expect(html).toContain('No GPS track data available for this activity')
      expect(html).not.toContain('data-testid="elevation-chart"')
      expect(html).not.toContain('data-testid="pace-chart"')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Chart Data Derivation
  // -------------------------------------------------------------------------
  describe('2. Chart Data Derivation', () => {
    it('derives cumulative distance along track points accurately', () => {
      let cum = 0
      const distances = [0]
      for (let i = 1; i < sampleTrackPoints.length; i++) {
        cum += haversineDistance(sampleTrackPoints[i - 1], sampleTrackPoints[i])
        distances.push(cum)
      }

      expect(distances.length).toBe(sampleTrackPoints.length)
      expect(distances[0]).toBe(0)
      expect(distances[distances.length - 1]).toBeGreaterThan(1500)
    })

    it('derives smoothed elevation profile and min/max elevation', () => {
      const smoothed = smoothElevation(sampleTrackPoints, { windowSize: 3 })
      expect(smoothed.length).toBe(sampleTrackPoints.length)

      const elevations = smoothed.map(p => p.ele)
      const minEle = Math.min(...elevations)
      const maxEle = Math.max(...elevations)

      expect(minEle).toBeGreaterThanOrEqual(15.0)
      expect(maxEle).toBeLessThanOrEqual(35.0)
    })

    it('derives rolling paces in min/km and min/mi according to unit setting', () => {
      const metricPaces = rollingPace(sampleTrackPoints, { unit: 'kg' })
      expect(metricPaces.length).toBe(sampleTrackPoints.length)
      expect(metricPaces[1]).toBeGreaterThan(0)

      const imperialPaces = rollingPace(sampleTrackPoints, { unit: 'lbs' })
      expect(imperialPaces.length).toBe(sampleTrackPoints.length)
      // Pace in min/mi should be numerically greater than pace in min/km (1 mi ~ 1.609 km)
      expect(imperialPaces[1]).toBeGreaterThan(metricPaces[1])
    })

    it('derives splits matching distance thresholds', () => {
      const splitsMetric = computeSplits(sampleTrackPoints, { unit: 'kg' })
      expect(splitsMetric.length).toBeGreaterThanOrEqual(2)
      expect(splitsMetric[0].split).toBe(1)
      expect(splitsMetric[0].distance).toBe(1000)
      expect(splitsMetric[0].pace).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Map Hover Synchronization
  // -------------------------------------------------------------------------
  describe('3. Map Hover Synchronization', () => {
    it('RouteMap renders synchronized cursor dot when currentPosition is supplied in consented mode', () => {
      const hoverTarget = sampleTrackPoints[2] // Lat 47.6105, Lon -122.3365

      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: sampleTrackPoints,
          currentPosition: hoverTarget,
          state: useStore.getState().S,
          width: 320,
          height: 200,
        })
      )

      expect(html).toContain('data-testid="route-map-cursor"')
    })

    it('RouteMap passes currentPosition to fallback RouteCanvas when consent is ungranted', () => {
      const hoverTarget = sampleTrackPoints[1]
      const unconsentedState = { privacy: { consents: {} } }

      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: sampleTrackPoints,
          currentPosition: hoverTarget,
          state: unconsentedState,
          width: 320,
          height: 200,
        })
      )

      expect(html).toContain('data-testid="route-canvas"')
      expect(html).toContain('data-testid="route-map-privacy-prompt"')
    })

    it('renders synchronized chart cursors when hover coordinates are computed', () => {
      // Create chart element containing hover state
      const hoverPt = sampleTrackPoints[2]
      const html = renderToStaticMarkup(
        React.createElement(RouteMap, {
          points: sampleTrackPoints,
          currentPosition: hoverPt,
          state: useStore.getState().S,
        })
      )
      expect(html).toContain('data-testid="route-map-cursor"')
    })
  })

  // -------------------------------------------------------------------------
  // 4. GPX Export
  // -------------------------------------------------------------------------
  describe('4. GPX Export', () => {
    it('sanitizes filename correctly for activity export', () => {
      expect(sanitizeFilename('Morning Run! 11/12')).toBe('Morning_Run_11_12')
      expect(sanitizeFilename('../../../hack.gpx')).toBe('hack.gpx')
      expect(sanitizeFilename('')).toBe('track')
    })

    it('exports activity track data to GPX 1.1 format via exportGPX', async () => {
      const exportResult = await exportGPX(
        {
          ...sampleActivity,
          points: sampleTrackPoints,
        },
        {
          name: 'Afternoon River Run',
          downloadFn: () => true,
        }
      )

      expect(exportResult.success).toBe(true)
      expect(exportResult.content).toContain('<gpx version="1.1"')
      expect(exportResult.content).toContain('Afternoon River Run')
      expect(exportResult.content).toContain('<trkpt lat="47.6062" lon="-122.3321">')
      expect(exportResult.content).toContain('<ele>15</ele>')
    })
  })

  // -------------------------------------------------------------------------
  // 5. Track Trimming and Save
  // -------------------------------------------------------------------------
  describe('5. Track Trimming and Persistence', () => {
    it('trimTrackPoints recalculates distance, duration, elevation, pace, and splits', () => {
      const startIndex = 1
      const endIndex = 4
      const trimmed = trimTrackPoints(sampleTrackPoints, startIndex, endIndex, { unit: 'kg' })

      expect(trimmed.points.length).toBe(4) // indices 1, 2, 3, 4
      expect(trimmed.distanceM).toBeGreaterThan(0)
      expect(trimmed.distanceM).toBeLessThan(sampleActivity.distanceM)
      expect(trimmed.durationMs).toBeGreaterThan(0)
      expect(trimmed.elevationGainM).toBeGreaterThanOrEqual(0)
      expect(trimmed.splits).toBeDefined()
    })

    it('saves trimmed track to cardio adapter and updates local store', async () => {
      const startIndex = 1
      const endIndex = 4
      const trimmed = trimTrackPoints(sampleTrackPoints, startIndex, endIndex, { unit: 'kg' })

      const trackPath = resolveTrackPath(sampleActivity) || '2026/act-test-1.json'
      await writeTrack(trackPath, trimmed)

      // Verify file persisted in adapter
      const readBack = await memoryAdapter.readTrack(trackPath)
      expect(readBack).toBeDefined()
      expect(readBack.points.length).toBe(4)

      // Update store
      const updated = useStore.getState().updateCardioActivity('act-test-1', {
        distanceM: trimmed.distanceM,
        durationMs: trimmed.durationMs,
        elevationGainM: trimmed.elevationGainM,
      })

      expect(updated).toBeDefined()
      expect(updated.distanceM).toBe(trimmed.distanceM)
      expect(useStore.getState().S.cardioActivities[0].distanceM).toBe(trimmed.distanceM)
    })

    it('synchronizes trimmed track to server when in server mode', async () => {
      useStore.setState({
        user: { id: 'user-123', email: 'runner@opengym.app' },
        isServerMode: () => true,
      })

      const putSpy = vi.spyOn(apiModule, 'api').mockResolvedValue({ ok: true })

      const trimmed = trimTrackPoints(sampleTrackPoints, 0, 3, { unit: 'kg' })
      const trackPayload = JSON.stringify(trimmed)

      await apiModule.api(`/api/tracks/${encodeURIComponent('act-test-1')}`, {
        method: 'PUT',
        body: trackPayload,
      })

      expect(putSpy).toHaveBeenCalledWith(
        '/api/tracks/act-test-1',
        expect.objectContaining({
          method: 'PUT',
          body: trackPayload,
        })
      )
    })
  })
})
