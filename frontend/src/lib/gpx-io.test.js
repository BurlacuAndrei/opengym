import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  sanitizeFilename,
  triggerBrowserDownload,
  exportGPX,
  parseGPXInput,
  importGPXAsActivity,
  importGPXAsRoute,
  importGPX
} from './gpx-io.js'
import GpxImportDialog, { openGpxImportDialog } from '../components/GpxImportDialog.jsx'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
  getCardioAdapter
} from './cardio-adapter.js'
import { useStore, DEF } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store }
  }
}

const SAMPLE_GPX_TRACK = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="OpenGym" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Sunday Morning 5k</name>
    <desc>Tempo run along river path</desc>
    <time>2026-11-08T08:00:00Z</time>
  </metadata>
  <trk>
    <name>Sunday Morning 5k</name>
    <trkseg>
      <trkpt lat="47.6062" lon="-122.3321">
        <ele>15.2</ele>
        <time>2026-11-08T08:00:00Z</time>
      </trkpt>
      <trkpt lat="47.6075" lon="-122.3335">
        <ele>18.5</ele>
        <time>2026-11-08T08:05:00Z</time>
      </trkpt>
      <trkpt lat="47.6090" lon="-122.3350">
        <ele>22.1</ele>
        <time>2026-11-08T08:10:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`

const SAMPLE_GPX_ROUTE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="OpenGym" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Trail Ridge Loop</name>
    <desc>Scenic mountain ridge route</desc>
  </metadata>
  <rte>
    <name>Trail Ridge Loop</name>
    <rtept lat="46.5000" lon="8.5000">
      <ele>1200</ele>
    </rtept>
    <rtept lat="46.5100" lon="8.5150">
      <ele>1350</ele>
    </rtept>
  </rte>
</gpx>`

describe('GPX Import & Export Subsystem (Issue #73)', () => {
  let adapter

  beforeEach(() => {
    localStorage.clear()
    adapter = createMemoryCardioAdapter()
    setCardioAdapter(adapter)
    useStore.setState({
      S: JSON.parse(JSON.stringify(DEF)),
      user: null
    })
    useUI.setState({
      sheet: null,
      toast: null
    })
  })

  describe('Filename & Browser Download Helpers', () => {
    it('sanitizes filename characters and strips leading/trailing underscores', () => {
      expect(sanitizeFilename('Morning Run: 5k (fast!)')).toBe('Morning_Run_5k_fast')
      expect(sanitizeFilename('../../../secret/track.gpx')).toBe('secret_track.gpx')
      expect(sanitizeFilename('   ')).toBe('track')
      expect(sanitizeFilename(null)).toBe('track')
    })

    it('triggerBrowserDownload creates anchor, triggers click, and removes it safely', () => {
      const clickSpy = vi.fn()
      const appendChildSpy = vi.fn()
      const removeChildSpy = vi.fn()

      const origDocument = globalThis.document
      const origBlob = globalThis.Blob
      const origURL = globalThis.URL

      globalThis.Blob = class MockBlob {
        constructor(parts, opts) {
          this.parts = parts
          this.opts = opts
        }
      }

      globalThis.URL = {
        createObjectURL: vi.fn(() => 'blob:mock-url'),
        revokeObjectURL: vi.fn()
      }

      globalThis.document = {
        createElement: vi.fn(tag => ({
          tagName: tag.toUpperCase(),
          click: clickSpy,
          style: {}
        })),
        body: {
          appendChild: appendChildSpy,
          removeChild: removeChildSpy
        }
      }

      try {
        const ok = triggerBrowserDownload('<gpx></gpx>', 'test.gpx')
        expect(ok).toBe(true)
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1)
        expect(clickSpy).toHaveBeenCalledTimes(1)
        expect(appendChildSpy).toHaveBeenCalledTimes(1)
        expect(removeChildSpy).toHaveBeenCalledTimes(1)
      } finally {
        globalThis.document = origDocument
        globalThis.Blob = origBlob
        globalThis.URL = origURL
      }
    })

    it('triggerBrowserDownload returns false gracefully in non-DOM environments', () => {
      const origDocument = globalThis.document
      try {
        delete globalThis.document
        const result = triggerBrowserDownload('<gpx></gpx>', 'test.gpx')
        expect(result).toBe(false)
      } finally {
        globalThis.document = origDocument
      }
    })
  })

  describe('exportGPX', () => {
    it('throws error when no data is provided', async () => {
      await expect(exportGPX(null)).rejects.toThrow('No data provided for GPX export')
    })

    it('exports activity with points array to valid GPX XML', async () => {
      const activity = {
        name: 'River Run',
        desc: 'Sunny morning',
        type: 'run',
        startTime: '2026-11-12T08:00:00Z',
        points: [
          { lat: 47.6062, lon: -122.3321, ele: 15, time: '2026-11-12T08:00:00Z' },
          { lat: 47.6075, lon: -122.3335, ele: 18, time: '2026-11-12T08:05:00Z' }
        ]
      }

      const downloadSpy = vi.fn()
      const res = await exportGPX(activity, {
        isMobile: false,
        downloadFn: downloadSpy
      })

      expect(res.success).toBe(true)
      expect(res.isMobile).toBe(false)
      expect(res.filename).toBe('River_Run.gpx')
      expect(res.content).toContain('<trk>')
      expect(res.content).toContain('<name>River Run</name>')
      expect(res.content).toContain('lat="47.6062"')
      expect(res.content).toContain('lon="-122.3321"')
      expect(downloadSpy).toHaveBeenCalledWith(res.content, 'River_Run.gpx')
    })

    it('delegates to mobile shareExport when isMobile is true', async () => {
      const activity = {
        name: 'Mobile Hike',
        points: [{ lat: 46.5, lon: 8.5 }]
      }

      const shareSpy = vi.fn().mockResolvedValue(true)
      const res = await exportGPX(activity, {
        isMobile: true,
        shareFn: shareSpy
      })

      expect(res.success).toBe(true)
      expect(res.isMobile).toBe(true)
      expect(res.filename).toBe('Mobile_Hike.gpx')
      expect(shareSpy).toHaveBeenCalledTimes(1)
      expect(shareSpy).toHaveBeenCalledWith(res.content, 'Mobile_Hike.gpx')
    })

    it('reads track file via adapter when activity has trackPath without inline points', async () => {
      await adapter.writeTrack('2026/act-async-1.json', {
        id: 'act-async-1',
        points: [
          { lat: 45.1, lon: 9.1, ele: 100, time: '2026-11-10T10:00:00Z' },
          { lat: 45.2, lon: 9.2, ele: 110, time: '2026-11-10T10:10:00Z' }
        ]
      })

      const activity = {
        id: 'act-async-1',
        name: 'Loaded Track',
        trackPath: '2026/act-async-1.json'
      }

      const downloadSpy = vi.fn()
      const res = await exportGPX(activity, {
        isMobile: false,
        downloadFn: downloadSpy,
        adapter
      })

      expect(res.content).toContain('lat="45.1"')
      expect(res.content).toContain('lon="9.1"')
      expect(res.content).toContain('<ele>100</ele>')
    })

    it('exports route with <rte> and <rtept> tags when type is route', async () => {
      const route = {
        name: 'Alpine Route',
        type: 'route',
        points: [
          { lat: 46.8, lon: 8.9 },
          { lat: 46.9, lon: 9.0 }
        ]
      }

      const downloadSpy = vi.fn()
      const res = await exportGPX(route, {
        isMobile: false,
        downloadFn: downloadSpy
      })

      expect(res.content).toContain('<rte>')
      expect(res.content).toContain('<rtept')
      expect(res.content).not.toContain('<trkseg>')
    })
  })

  describe('parseGPXInput', () => {
    it('parses valid GPX XML string into structured points and analytical summary', async () => {
      const parsed = await parseGPXInput(SAMPLE_GPX_TRACK)

      expect(parsed.name).toBe('Sunday Morning 5k')
      expect(parsed.desc).toBe('Tempo run along river path')
      expect(parsed.points).toHaveLength(3)
      expect(parsed.points[0].lat).toBeCloseTo(47.6062, 4)
      expect(parsed.points[0].lon).toBeCloseTo(-122.3321, 4)
      expect(parsed.points[0].ele).toBe(15.2)

      // Summary checks
      expect(parsed.summary.totalDistance).toBeGreaterThan(300)
      expect(parsed.summary.elapsedTime).toBe(600) // 10 minutes between 08:00 and 08:10
      expect(parsed.summary.elevationGain).toBeCloseTo(6.9, 1)
    })

    it('parses input from Blob / File with .text() method', async () => {
      const mockFile = {
        name: 'activity.gpx',
        text: async () => SAMPLE_GPX_TRACK
      }

      const parsed = await parseGPXInput(mockFile)
      expect(parsed.name).toBe('Sunday Morning 5k')
      expect(parsed.points).toHaveLength(3)
    })

    it('rejects null, empty, or whitespace-only GPX input', async () => {
      await expect(parseGPXInput('')).rejects.toThrow('Invalid or empty GPX input')
      await expect(parseGPXInput('   ')).rejects.toThrow('Invalid GPX: file is empty')
      await expect(parseGPXInput(null)).rejects.toThrow('Invalid or empty GPX input')
    })
  })

  describe('importGPXAsActivity', () => {
    it('creates completed activity, writes track file to adapter, and updates cardioActivities in store', async () => {
      const res = await importGPXAsActivity(SAMPLE_GPX_TRACK, {
        type: 'run',
        adapter
      })

      expect(res.activity).toBeDefined()
      expect(res.activity.name).toBe('Sunday Morning 5k')
      expect(res.activity.type).toBe('run')
      expect(res.activity.startTime).toBe('2026-11-08T08:00:00Z')
      expect(res.activity.distanceM).toBeGreaterThan(300)
      expect(res.activity.durationMs).toBe(600000) // 10 minutes
      expect(res.activity.avgPaceSecKm).toBeGreaterThan(0)
      expect(res.activity.avgSpeedKmh).toBeGreaterThan(0)
      expect(res.activity.trackPath).toMatch(/^2026\/[^/]+\.json$/)

      // Verify track file in CardioAdapter
      const trackFile = await adapter.readTrack(res.trackPath)
      expect(trackFile).not.toBeNull()
      expect(trackFile.id).toBe(res.activity.id)
      expect(trackFile.type).toBe('run')
      expect(trackFile.points).toHaveLength(3)
      expect(trackFile.summary.distanceM).toBe(res.activity.distanceM)

      // Verify store updated
      const storeActivities = useStore.getState().S.cardioActivities
      expect(storeActivities).toHaveLength(1)
      expect(storeActivities[0].id).toBe(res.activity.id)
      expect(storeActivities[0].trackPath).toBe(res.trackPath)
    })

    it('allows overriding activity type, custom name, notes, gearId, and rpe', async () => {
      const res = await importGPXAsActivity(SAMPLE_GPX_TRACK, {
        type: 'hike',
        name: 'Custom Morning Trek',
        notes: 'Chilly morning with steep climb',
        gearId: 'boots_trail_01',
        rpe: 8,
        adapter
      })

      expect(res.activity.type).toBe('hike')
      expect(res.activity.name).toBe('Custom Morning Trek')
      expect(res.activity.notes).toBe('Chilly morning with steep climb')
      expect(res.activity.gearId).toBe('boots_trail_01')
      expect(res.activity.rpe).toBe(8)
    })

    it('throws error when GPX contains zero trackpoints', async () => {
      const emptyGpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="test"><metadata><name>Empty</name></metadata></gpx>`
      await expect(importGPXAsActivity(emptyGpx, { adapter })).rejects.toThrow(
        'GPX contains no GPS trackpoints'
      )
    })
  })

  describe('importGPXAsRoute', () => {
    it('creates saved route, writes route file to adapter, and updates state.routes and state.savedRoutes', async () => {
      const res = await importGPXAsRoute(SAMPLE_GPX_ROUTE, {
        adapter
      })

      expect(res.route).toBeDefined()
      expect(res.route.name).toBe('Trail Ridge Loop')
      expect(res.route.type).toBe('route')
      expect(res.route.distanceM).toBeGreaterThan(1000)
      expect(res.route.elevationGainM).toBe(150) // 1350 - 1200
      expect(res.route.trackPath).toMatch(/^routes\/[^/]+\.json$/)

      // Verify route file in CardioAdapter
      const routeFile = await adapter.readTrack(res.trackPath)
      expect(routeFile).not.toBeNull()
      expect(routeFile.type).toBe('route')
      expect(routeFile.points).toHaveLength(2)

      // Verify store state
      const state = useStore.getState().S
      expect(state.routes).toHaveLength(1)
      expect(state.routes[0].id).toBe(res.route.id)
      expect(state.savedRoutes).toHaveLength(1)
      expect(state.savedRoutes[0].id).toBe(res.route.id)
    })

    it('preserves custom route name and custom trackPath overrides', async () => {
      const res = await importGPXAsRoute(SAMPLE_GPX_ROUTE, {
        name: 'My Ridge Circuit',
        trackPath: 'routes/custom-ridge.json',
        adapter
      })

      expect(res.route.name).toBe('My Ridge Circuit')
      expect(res.trackPath).toBe('routes/custom-ridge.json')

      const stored = await adapter.readTrack('routes/custom-ridge.json')
      expect(stored.name).toBe('My Ridge Circuit')
    })
  })

  describe('importGPX Router', () => {
    it('dispatches to activity import when destination is activity', async () => {
      const res = await importGPX(SAMPLE_GPX_TRACK, 'activity', { adapter })
      expect(res.activity).toBeDefined()
      expect(res.route).toBeUndefined()
    })

    it('dispatches to route import when destination is route or saved-route', async () => {
      const resRoute = await importGPX(SAMPLE_GPX_ROUTE, 'route', { adapter })
      expect(resRoute.route).toBeDefined()

      const resSaved = await importGPX(SAMPLE_GPX_ROUTE, 'saved-route', { adapter })
      expect(resSaved.route).toBeDefined()
    })
  })

  describe('GpxImportDialog Component', () => {
    it('renders metrics preview and destination controls for parsed GPX', () => {
      const parsedData = {
        name: 'Peak Summit',
        desc: 'Rocky trail',
        points: [
          { lat: 46.5, lon: 8.5, ele: 1000 },
          { lat: 46.6, lon: 8.6, ele: 1400 }
        ],
        summary: {
          totalDistance: 13500,
          movingTime: 7200,
          elapsedTime: 7500,
          elevationGain: 400
        }
      }

      const html = renderToStaticMarkup(
        React.createElement(GpxImportDialog, {
          gpxData: parsedData,
          close: () => {}
        })
      )

      expect(html).toContain('Import GPX')
      expect(html).toContain('Peak Summit')
      expect(html).toContain('Distance')
      expect(html).toContain('Elevation Gain')
      expect(html).toContain('Past Activity')
      expect(html).toContain('Saved Route')
      expect(html).toContain('Import as Activity')
    })

    it('renders loading view when file is provided but parsing is in flight', () => {
      const html = renderToStaticMarkup(
        React.createElement(GpxImportDialog, {
          file: { name: 'run.gpx', text: () => new Promise(() => {}) },
          close: () => {}
        })
      )
      expect(html).toContain('Parsing GPX track…')
    })

    it('openGpxImportDialog opens sheet via useUI', () => {
      const openSheetSpy = vi.fn()
      useUI.setState({ openSheet: openSheetSpy })

      openGpxImportDialog({ defaultDestination: 'route' })
      expect(openSheetSpy).toHaveBeenCalledTimes(1)
      expect(typeof openSheetSpy.mock.calls[0][0]).toBe('function')
    })
  })
})
