import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ActivityDetail, {
  saveActivityAsRoute,
  correctActivityElevation,
} from './ActivityDetail.jsx'
import { fmtDate } from '../lib/format.js'
import { useStore, DEF } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { EXTERNAL_FEATURES } from '../lib/privacy.js'
import {
  ELEVATION_FEATURE_ID,
  ElevationConsentError,
} from '../lib/elevation-api.js'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
  getCardioAdapter,
  writeTrack,
} from '../lib/cardio-adapter.js'
import { exportGPX, sanitizeFilename } from '../lib/gpx-io.js'
import { trimTrackPoints, trimTrack, resolveTrackPath } from '../lib/track-trim.js'
import RouteMap, { OSM_FEATURE_ID } from '../components/RouteMap.jsx'
import { Slider } from '../components/ui.jsx'
import {
  haversineDistance,
  rollingPace,
  smoothElevation,
  computeSplits,
  totalDistance,
} from '../lib/track-math.js'
import * as apiModule from '../lib/api.js'

vi.mock('../store/useStore.js', async importOriginal => {
  const actual = await importOriginal()
  const useStoreMock = selector => {
    const s = actual.useStore.getState()
    return selector ? selector(s) : s
  }
  Object.assign(useStoreMock, actual.useStore)
  return { ...actual, useStore: useStoreMock }
})

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
      expect(html).toContain('data-testid="activity-date"')
      expect(html).toContain(fmtDate(sampleActivity.d, true))
      expect(html).not.toContain('Invalid Date')
      expect(html).toContain('data-testid="activity-kpi-grid"')
      expect(html).toContain('data-testid="kpi-distance"')
      expect(html).toContain('data-testid="kpi-duration"')
      expect(html).toContain('data-testid="kpi-rate"')
      expect(html).toContain('data-testid="kpi-elevation"')
      expect(html).toContain('+35 m')
    })

    it('renders valid date for ISO-only and numeric epoch startTime without Invalid Date', () => {
      const isoActivity = {
        ...sampleActivity,
        d: undefined,
        startTime: '2026-11-12T14:30:00Z',
      }
      const isoHtml = renderToStaticMarkup(
        React.createElement(ActivityDetail, { activity: isoActivity })
      )
      expect(isoHtml).toContain('data-testid="activity-date"')
      expect(isoHtml).toContain(fmtDate(isoActivity.startTime, true))
      expect(isoHtml).not.toContain('Invalid Date')

      const numActivity = {
        ...sampleActivity,
        d: undefined,
        startTime: 1731400000000,
      }
      const numHtml = renderToStaticMarkup(
        React.createElement(ActivityDetail, { activity: numActivity })
      )
      expect(numHtml).toContain('data-testid="activity-date"')
      expect(numHtml).toContain(fmtDate(numActivity.startTime, true))
      expect(numHtml).not.toContain('Invalid Date')
    })

    it('renders multi-line notes and hides notes card when empty or whitespace-only', () => {
      const notedHtml = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: { ...sampleActivity, notes: '  Line 1\nLine 2  ' },
        })
      )
      expect(notedHtml).toContain('data-testid="activity-notes"')
      expect(notedHtml).toContain('Notes')
      expect(notedHtml).toContain('Line 1\nLine 2')

      for (const emptyNotes of [undefined, null, '', '   \n\t  ']) {
        const html = renderToStaticMarkup(
          React.createElement(ActivityDetail, {
            activity: { ...sampleActivity, notes: emptyNotes },
          })
        )
        expect(html).not.toContain('data-testid="activity-notes"')
      }
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

    it('formats avgPaceSecKm KPI without double-dividing splits and supports imperial lb', () => {
      const kgHtml = renderToStaticMarkup(
        React.createElement(ActivityDetail, { activity: sampleActivity })
      )
      expect(kgHtml).toContain('6:00 min/km')
      expect(kgHtml).not.toContain('360:00')
      const split1Match = kgHtml.match(/data-testid="split-row-1"[\s\S]*?<\/tr>/)
      expect(split1Match?.[0]).toMatch(/[1-9]\d?:\d{2} min\/km/)

      useStore.setState({ S: { ...useStore.getState().S, unit: 'lb' } })
      const lbHtml = renderToStaticMarkup(
        React.createElement(ActivityDetail, { activity: sampleActivity })
      )
      expect(lbHtml).toContain('9:39 min/mi')
      expect(lbHtml).not.toContain('360:00')
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
      expect(html).not.toContain('data-testid="activity-date"')
      expect(html).not.toContain('Invalid Date')
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

  // -------------------------------------------------------------------------
  // 6. Activity Detail Actions: Edit, Save as Route, DEM Elevation Correction
  // -------------------------------------------------------------------------
  describe('6. Activity Detail Actions (Issue #96)', () => {
    it('registers elevation_lookup in EXTERNAL_FEATURES', () => {
      const feat = EXTERNAL_FEATURES.find(f => f.id === ELEVATION_FEATURE_ID)
      expect(feat).toBeDefined()
      expect(feat.recipient).toContain('Open-Meteo')
    })

    it('renders Edit, Save as Route, and Correct Elevation when trackPoints exist, and hides route/elevation actions without points', () => {
      const withPts = renderToStaticMarkup(
        React.createElement(ActivityDetail, { activity: sampleActivity })
      )
      expect(withPts).toContain('data-testid="edit-activity-btn"')
      expect(withPts).toContain('data-testid="save-route-btn"')
      expect(withPts).toContain('data-testid="correct-elevation-btn"')

      const noPts = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: { ...sampleActivity, points: [], track: undefined },
        })
      )
      expect(noPts).toContain('data-testid="edit-activity-btn"')
      expect(noPts).not.toContain('data-testid="save-route-btn"')
      expect(noPts).not.toContain('data-testid="correct-elevation-btn"')
    })

    it('saveActivityAsRoute writes routes/<id>.json, appends to S.routes and S.savedRoutes, and syncs in server mode', async () => {
      const putSpy = vi.spyOn(apiModule, 'api').mockResolvedValue({ ok: true })
      const res = await saveActivityAsRoute(sampleActivity, sampleTrackPoints, {
        isServerMode: true,
      })
      expect(res.route).toBeDefined()
      expect(res.trackPath).toBe(`routes/${res.route.id}.json`)

      const stored = await memoryAdapter.readTrack(res.trackPath)
      expect(stored.points.length).toBe(sampleTrackPoints.length)

      const state = useStore.getState().S
      expect(state.routes.some(r => r.id === res.route.id)).toBe(true)
      expect(state.savedRoutes.some(r => r.id === res.route.id)).toBe(true)
      expect(putSpy).toHaveBeenCalledWith(
        `/api/routes/${encodeURIComponent(res.route.id)}`,
        expect.objectContaining({ method: 'PUT' })
      )
    })

    it('correctActivityElevation enforces consent, updates track + store + server when granted, and handles all-null DEM response', async () => {
      await expect(
        correctActivityElevation(sampleActivity, null, sampleTrackPoints, {
          state: { ...DEF, privacy: { consents: {} } },
        })
      ).rejects.toThrow(ElevationConsentError)

      const consentedState = {
        ...DEF,
        unit: 'kg',
        privacy: {
          consents: {
            [ELEVATION_FEATURE_ID]: { agreedAt: new Date().toISOString(), version: 1 },
          },
        },
      }
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ elevation: [100, 120, 145, 160, 155, 170] }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const putSpy = vi.spyOn(apiModule, 'api').mockResolvedValue({ ok: true })

      const res = await correctActivityElevation(sampleActivity, null, sampleTrackPoints, {
        state: consentedState,
        updateCardioActivity: useStore.getState().updateCardioActivity,
        isServerMode: true,
      })

      expect(res.updatedTrack.points.length).toBe(sampleTrackPoints.length)
      expect(res.patch.elevationGainM).toBeGreaterThan(0)
      expect(useStore.getState().S.cardioActivities[0].elevationGainM).toBe(res.patch.elevationGainM)
      const savedTrack = await memoryAdapter.readTrack(resolveTrackPath(sampleActivity))
      expect(savedTrack.elevationGainM).toBe(res.patch.elevationGainM)
      expect(putSpy).toHaveBeenCalledWith(
        '/api/tracks/act-test-1',
        expect.objectContaining({ method: 'PUT' })
      )

      // All-null DEM response returns unavailable
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ elevation: [null, null, null, null, null, null] }),
      })
      const unavail = await correctActivityElevation(sampleActivity, null, sampleTrackPoints, {
        state: consentedState,
      })
      expect(unavail).toEqual({ unavailable: true })
    })
  })

  // -------------------------------------------------------------------------
  // 7. Compact Header, Track Actions, Slider Trim, and Bottom Clearance (Issue #6)
  // -------------------------------------------------------------------------
  describe('7. Compact Header, Track Actions, Slider Trim, and Bottom Clearance (Issue #6)', () => {
    it('renders compact topbar with iconbtn back button, sm header buttons, and separate track actions row', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, { activity: sampleActivity })
      )

      expect(html).toContain('activity-detail-topbar')
      expect(html).toMatch(/<button[^>]*class="iconbtn"[^>]*aria-label="Back"[^>]*data-testid="back-btn"/)
      expect(html).toMatch(/<button[^>]*class="btn plain sm\s*"[^>]*data-testid="edit-activity-btn"/)
      expect(html).toMatch(/<button[^>]*class="btn plain sm\s*"[^>]*data-testid="gpx-export-btn"/)
      expect(html).toContain('activity-track-actions')
      expect(html).toMatch(/<button[^>]*class="btn tinted sm\s*"[^>]*data-testid="save-route-btn"/)
      expect(html).toMatch(/<button[^>]*class="btn tinted sm\s*"[^>]*data-testid="correct-elevation-btn"/)
      expect(html).toMatch(/<button[^>]*class="btn tinted sm\s*"[^>]*data-testid="trim-toggle-btn"/)
    })

    it('hides track action row when trackPoints.length === 0 and disables GPX export', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: { ...sampleActivity, points: [], track: undefined },
        })
      )

      expect(html).not.toContain('activity-track-actions')
      expect(html).not.toContain('data-testid="save-route-btn"')
      expect(html).not.toContain('data-testid="correct-elevation-btn"')
      expect(html).not.toContain('data-testid="trim-toggle-btn"')
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="gpx-export-btn"/)
    })

    it('renders Slider controls in initialTrimMode with no native range inputs', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, {
          activity: sampleActivity,
          initialTrimMode: true,
        })
      )

      expect(html).toContain('data-testid="trim-controls"')
      expect(html).toMatch(/<button[^>]*class="btn primary sm\s*"[^>]*data-testid="trim-toggle-btn"/)
      expect(html).not.toContain('type="range"')
      expect(html).toContain('role="slider"')
      expect(html).toContain('data-testid="trim-start-slider"')
      expect(html).toContain('data-testid="trim-end-slider"')
      expect(html).toContain('aria-label="Start Point"')
      expect(html).toContain('aria-label="End Point"')
      expect(html).toContain('aria-valuenow="0"')
      expect(html).toContain(`aria-valuenow="${sampleTrackPoints.length - 1}"`)
      expect(html).toContain(`aria-valuemax="${sampleTrackPoints.length - 1}"`)
      expect(html).toContain('6 / 6 points')
      expect(html).toMatch(/<button[^>]*class="btn plain sm\s*"[^>]*data-testid="trim-cancel-btn"/)
      expect(html).toMatch(/<button[^>]*class="btn primary sm\s*"[^>]*data-testid="trim-save-btn"/)
    })

    it('Slider handles SSR edge cases: value=0, min===max, value=undefined, and ...rest props', () => {
      const zeroHtml = renderToStaticMarkup(
        React.createElement(Slider, { value: 0, min: 0, max: 5, onChange: () => {} })
      )
      expect(zeroHtml).toContain('aria-valuenow="0"')
      expect(zeroHtml).toContain('width:0%')
      expect(zeroHtml).toContain('left:0%')

      const equalBoundsHtml = renderToStaticMarkup(
        React.createElement(Slider, { value: 3, min: 3, max: 3, onChange: () => {} })
      )
      expect(equalBoundsHtml).toContain('aria-valuenow="3"')
      expect(equalBoundsHtml).toContain('width:0%')
      expect(equalBoundsHtml).toContain('left:0%')
      expect(equalBoundsHtml).not.toContain('NaN')

      const undefHtml = renderToStaticMarkup(
        React.createElement(Slider, { value: undefined, min: 2, max: 10, onChange: () => {} })
      )
      expect(undefHtml).toContain('aria-valuenow="2"')
      expect(undefHtml).toContain('width:0%')

      const restHtml = renderToStaticMarkup(
        React.createElement(Slider, {
          value: 2,
          min: 0,
          max: 4,
          onChange: () => {},
          'data-testid': 'custom-slider',
          'aria-label': 'Trim point',
        })
      )
      expect(restHtml).toContain('data-testid="custom-slider"')
      expect(restHtml).toContain('aria-label="Trim point"')
      expect(restHtml).toContain('width:50%')
    })

    it('sets safe-area bottom padding clearance on .activity-detail-view without 16px outer padding', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActivityDetail, { activity: sampleActivity })
      )

      expect(html).toContain('padding-bottom:calc(32px + var(--sab))')
      expect(html).not.toContain('padding:16px;max-width:720px')
    })
  })
})
