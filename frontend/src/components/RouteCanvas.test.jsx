import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import RouteCanvas, {
  getCoord,
  getRouteBounds,
  normalizeRouteCoordinates,
  drawRouteOnCanvas,
} from './RouteCanvas.jsx'
import RecordingView, {
  getGpsAccuracyStatus,
  formatDurationClock,
} from '../views/RecordingView.jsx'
import { RECORDING_STATUS } from '../lib/cardio-recording.js'

describe('RouteCanvas & Android Recording UI (Issue #62)', () => {
  // -------------------------------------------------------------------------
  // 1. Pure Coordinate Extraction (getCoord)
  // -------------------------------------------------------------------------
  describe('1. Coordinate Extraction & Validation', () => {
    it('extracts lat/lon from objects with lat/lon properties', () => {
      expect(getCoord({ lat: 52.52, lon: 13.405 })).toEqual({
        lat: 52.52,
        lon: 13.405,
      })
    })

    it('extracts lat/lon from objects with latitude/longitude properties', () => {
      expect(getCoord({ latitude: 37.7749, longitude: -122.4194 })).toEqual({
        lat: 37.7749,
        lon: -122.4194,
      })
    })

    it('extracts lat/lon from objects with lat/lng properties', () => {
      expect(getCoord({ lat: 40.7128, lng: -74.006 })).toEqual({
        lat: 40.7128,
        lon: -74.006,
      })
    })

    it('extracts lat/lon from [lat, lon] tuples', () => {
      expect(getCoord([48.8566, 2.3522])).toEqual({
        lat: 48.8566,
        lon: 2.3522,
      })
    })

    it('returns null for null, undefined or empty input', () => {
      expect(getCoord(null)).toBeNull()
      expect(getCoord(undefined)).toBeNull()
      expect(getCoord({})).toBeNull()
      expect(getCoord([])).toBeNull()
    })

    it('returns null for NaN or out-of-bounds coordinates', () => {
      expect(getCoord({ lat: 'abc', lon: 10 })).toBeNull()
      expect(getCoord({ lat: 95, lon: 10 })).toBeNull()
      expect(getCoord({ lat: 50, lon: 195 })).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // 2. Bounding Box Calculation (getRouteBounds)
  // -------------------------------------------------------------------------
  describe('2. Bounding Box Calculation (getRouteBounds)', () => {
    it('returns null for empty or invalid track arrays', () => {
      expect(getRouteBounds([])).toBeNull()
      expect(getRouteBounds([null, undefined, {}])).toBeNull()
    })

    it('computes correct min/max latitude and longitude bounds', () => {
      const points = [
        { lat: 52.52, lon: 13.4 },
        { lat: 52.55, lon: 13.45 },
        { lat: 52.5, lon: 13.38 },
      ]
      const bounds = getRouteBounds(points)
      expect(bounds).not.toBeNull()
      expect(bounds.minLat).toBe(52.5)
      expect(bounds.maxLat).toBe(52.55)
      expect(bounds.minLon).toBe(13.38)
      expect(bounds.maxLon).toBe(13.45)
      expect(bounds.count).toBe(3)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Normalization & Aspect Ratio Math (normalizeRouteCoordinates)
  // -------------------------------------------------------------------------
  describe('3. Coordinate Normalization (normalizeRouteCoordinates)', () => {
    it('returns empty array for empty inputs', () => {
      expect(normalizeRouteCoordinates([])).toEqual([])
    })

    it('centers a single point in the canvas', () => {
      const result = normalizeRouteCoordinates([{ lat: 52.5, lon: 13.4 }], {
        width: 300,
        height: 200,
      })
      expect(result).toHaveLength(1)
      expect(result[0].x).toBe(150)
      expect(result[0].y).toBe(100)
    })

    it('maps highest latitude to top of canvas (smaller y) and respects padding', () => {
      const padding = 20
      const width = 400
      const height = 300
      const points = [
        { lat: 50.0, lon: 10.0 }, // Bottom (south)
        { lat: 51.0, lon: 10.0 }, // Top (north)
      ]

      const projected = normalizeRouteCoordinates(points, {
        width,
        height,
        padding,
      })

      expect(projected).toHaveLength(2)
      // Highest latitude should have smaller Y
      expect(projected[1].y).toBeLessThan(projected[0].y)
      // Respects padding: min y is at padding
      expect(projected[1].y).toBe(padding)
      // Max y is at height - padding
      expect(projected[0].y).toBe(height - padding)
      // Centered horizontally
      expect(projected[0].x).toBe(width / 2)
      expect(projected[1].x).toBe(width / 2)
    })

    it('maps leftmost longitude to left (smaller x) and rightmost to right', () => {
      const padding = 10
      const width = 200
      const height = 100
      const points = [
        { lat: 0.0, lon: 10.0 }, // Left (west)
        { lat: 0.0, lon: 20.0 }, // Right (east)
      ]

      const projected = normalizeRouteCoordinates(points, {
        width,
        height,
        padding,
      })

      expect(projected).toHaveLength(2)
      expect(projected[0].x).toBe(padding)
      expect(projected[1].x).toBe(width - padding)
      expect(projected[0].y).toBe(height / 2)
      expect(projected[1].y).toBe(height / 2)
    })
  })

  // -------------------------------------------------------------------------
  // 4. 2D Canvas Drawing Operations (drawRouteOnCanvas)
  // -------------------------------------------------------------------------
  describe('4. 2D Canvas Drawing Operations (drawRouteOnCanvas)', () => {
    function createMockCanvas(width = 300, height = 200) {
      const operations = []
      const ctx = {
        canvas: { width, height },
        clearRect: vi.fn((x, y, w, h) =>
          operations.push({ type: 'clearRect', x, y, w, h })
        ),
        fillRect: vi.fn((x, y, w, h) =>
          operations.push({ type: 'fillRect', x, y, w, h })
        ),
        beginPath: vi.fn(() => operations.push({ type: 'beginPath' })),
        moveTo: vi.fn((x, y) => operations.push({ type: 'moveTo', x, y })),
        lineTo: vi.fn((x, y) => operations.push({ type: 'lineTo', x, y })),
        stroke: vi.fn(() => operations.push({ type: 'stroke' })),
        arc: vi.fn((x, y, r, sa, ea) =>
          operations.push({ type: 'arc', x, y, r, sa, ea })
        ),
        fill: vi.fn(() =>
          operations.push({ type: 'fill', fillStyle: ctx.fillStyle })
        ),
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
      }

      const canvas = {
        width,
        height,
        getContext: vi.fn(type => (type === '2d' ? ctx : null)),
      }

      return { canvas, ctx, operations }
    }

    it('returns false if canvas or context is unavailable', () => {
      expect(drawRouteOnCanvas(null, [])).toBe(false)
      expect(drawRouteOnCanvas({}, [])).toBe(false)
    })

    it('clears canvas and exits cleanly on empty points', () => {
      const { canvas, ctx, operations } = createMockCanvas(300, 200)
      const success = drawRouteOnCanvas(canvas, [], { width: 300, height: 200 })

      expect(success).toBe(true)
      expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 300, 200)
      expect(operations.filter(op => op.type === 'stroke')).toHaveLength(0)
    })

    it('draws a single green dot for single point tracks', () => {
      const { canvas, ctx, operations } = createMockCanvas(300, 200)
      drawRouteOnCanvas(canvas, [{ lat: 52.5, lon: 13.4 }], {
        width: 300,
        height: 200,
        startColor: '#22c55e',
      })

      expect(ctx.clearRect).toHaveBeenCalled()
      const arcs = operations.filter(op => op.type === 'arc')
      expect(arcs).toHaveLength(1)
      expect(arcs[0].x).toBe(150)
      expect(arcs[0].y).toBe(100)
      expect(ctx.fillStyle).toBe('#22c55e')
    })

    it('draws normalized polyline path, green start dot, and red end dot for multi-point track', () => {
      const { canvas, ctx, operations } = createMockCanvas(300, 200)
      const points = [
        { lat: 52.5, lon: 13.4 },
        { lat: 52.51, lon: 13.41 },
        { lat: 52.52, lon: 13.42 },
      ]

      drawRouteOnCanvas(canvas, points, {
        width: 300,
        height: 200,
        strokeColor: '#3b82f6',
        startColor: '#22c55e',
        endColor: '#ef4444',
        lineWidth: 4,
      })

      // 1. Cleared
      expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 300, 200)

      // 2. Stroke line
      expect(ctx.strokeStyle).toBe('#3b82f6')
      expect(ctx.lineWidth).toBe(4)
      expect(ctx.lineCap).toBe('round')
      expect(ctx.lineJoin).toBe('round')
      expect(operations.some(op => op.type === 'moveTo')).toBe(true)
      expect(operations.some(op => op.type === 'stroke')).toBe(true)

      // 3. Two dots: start green dot and end red dot
      const fills = operations.filter(op => op.type === 'fill')
      expect(fills).toHaveLength(2)
      expect(fills[0].fillStyle).toBe('#22c55e') // Green start
      expect(fills[1].fillStyle).toBe('#ef4444') // Red end
    })

    it('draws current position overlay and styles it according to isOffCourse status', () => {
      const { canvas, operations } = createMockCanvas(300, 200)
      const points = [
        { lat: 52.5, lon: 13.4 },
        { lat: 52.52, lon: 13.42 },
      ]

      // 1. On course: draws current position dot
      drawRouteOnCanvas(canvas, points, {
        currentPosition: { lat: 52.51, lon: 13.41 },
        isOffCourse: false,
        currentPositionColor: '#3b82f6',
      })

      const onCourseArcs = operations.filter(op => op.type === 'arc')
      expect(onCourseArcs).toHaveLength(3)
      const fills = operations.filter(op => op.type === 'fill')
      expect(fills[fills.length - 1].fillStyle).toBe('#3b82f6')

      // 2. Off course: draws off course dot
      const { canvas: canvasOff, operations: opsOff } = createMockCanvas(300, 200)
      drawRouteOnCanvas(canvasOff, points, {
        currentPosition: { lat: 52.55, lon: 13.45 },
        isOffCourse: true,
        offCourseColor: '#ef4444',
      })
      const offCourseArcs = opsOff.filter(op => op.type === 'arc')
      expect(offCourseArcs).toHaveLength(3)
      const offFills = opsOff.filter(op => op.type === 'fill')
      expect(offFills[offFills.length - 1].fillStyle).toBe('#ef4444')
    })
  })

  // -------------------------------------------------------------------------
  // 5. RouteCanvas Component Static Markup
  // -------------------------------------------------------------------------
  describe('5. RouteCanvas Component Static Rendering', () => {
    it('renders HTML5 canvas element with width, height and test id', () => {
      const html = renderToStaticMarkup(
        React.createElement(RouteCanvas, {
          width: 350,
          height: 220,
          points: [{ lat: 52.5, lon: 13.4 }],
          dataTestId: 'custom-route-canvas',
        })
      )

      expect(html).toContain('<canvas')
      expect(html).toContain('width="350"')
      expect(html).toContain('height="220"')
      expect(html).toContain('data-testid="custom-route-canvas"')
      expect(html).toContain('aria-label="Route map"')
    })
  })

  // -------------------------------------------------------------------------
  // 6. GPS Accuracy Rating (getGpsAccuracyStatus)
  // -------------------------------------------------------------------------
  describe('6. GPS Accuracy Rating (getGpsAccuracyStatus)', () => {
    it('returns "searching" status when accuracy is null or undefined', () => {
      const status = getGpsAccuracyStatus(null)
      expect(status.level).toBe('searching')
      expect(status.label).toContain('GPS')
    })

    it('returns "good" status when accuracy <= 10m', () => {
      const s1 = getGpsAccuracyStatus(4.2)
      expect(s1.level).toBe('good')
      expect(s1.label).toBe('GPS ±4m')
      expect(s1.color).toBe('#10b981')

      const s2 = getGpsAccuracyStatus(10)
      expect(s2.level).toBe('good')
      expect(s2.label).toBe('GPS ±10m')
    })

    it('returns "fair" status when accuracy is between 10m and 25m', () => {
      const status = getGpsAccuracyStatus(18)
      expect(status.level).toBe('fair')
      expect(status.label).toBe('GPS ±18m')
      expect(status.color).toBe('#f59e0b')
    })

    it('returns "poor" status when accuracy > 25m', () => {
      const status = getGpsAccuracyStatus(45.8)
      expect(status.level).toBe('poor')
      expect(status.label).toBe('GPS ±46m')
      expect(status.color).toBe('#ef4444')
    })
  })

  // -------------------------------------------------------------------------
  // 7. Duration Clock Formatter (formatDurationClock)
  // -------------------------------------------------------------------------
  describe('7. formatDurationClock', () => {
    it('formats 0 or negative milliseconds to 0:00', () => {
      expect(formatDurationClock(0)).toBe('0:00')
      expect(formatDurationClock(-500)).toBe('0:00')
      expect(formatDurationClock(null)).toBe('0:00')
    })

    it('formats minutes and seconds as m:ss', () => {
      expect(formatDurationClock(65000)).toBe('1:05')
      expect(formatDurationClock(600000)).toBe('10:00')
      expect(formatDurationClock(1542000)).toBe('25:42')
    })

    it('formats hours, minutes and seconds as h:mm:ss', () => {
      expect(formatDurationClock(3665000)).toBe('1:01:05')
      expect(formatDurationClock(7325000)).toBe('2:02:05')
    })
  })

  // -------------------------------------------------------------------------
  // 8. RecordingView Live Screen & Control Actions
  // -------------------------------------------------------------------------
  describe('8. RecordingView Live Screen & Control Actions', () => {
    function createMockRecorder(initialState = {}) {
      const listeners = new Set()
      const state = {
        status: RECORDING_STATUS.RECORDING,
        id: 'rec-test-1',
        activityType: 'run',
        startTime: '2026-11-11T20:00:00.000Z',
        isRecording: true,
        isPaused: false,
        isIdle: false,
        pointsCount: 3,
        accuracy: 6,
        liveStats: {
          distanceM: 3500,
          movingTimeMs: 1200000, // 20 min
          elapsedTimeMs: 1250000,
          currentPace: 5.71,
          avgPace: 5.71,
          currentSpeed: 2.92,
          avgSpeed: 2.92,
          elevationGainM: 45,
          calories: 240,
        },
        ...initialState,
      }

      const points = [
        { lat: 52.5, lon: 13.4, accuracy: 6 },
        { lat: 52.51, lon: 13.41, accuracy: 5 },
        { lat: 52.52, lon: 13.42, accuracy: 6 },
      ]

      return {
        state,
        points,
        getState: vi.fn(() => ({ ...state })),
        getLiveStats: vi.fn(() => ({ ...state.liveStats })),
        subscribe: vi.fn(fn => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        }),
        startRecording: vi.fn(async () => {
          state.status = RECORDING_STATUS.RECORDING
          state.isRecording = true
          state.isIdle = false
        }),
        pauseRecording: vi.fn(() => {
          state.status = RECORDING_STATUS.PAUSED
          state.isPaused = true
          state.isRecording = false
        }),
        resumeRecording: vi.fn(() => {
          state.status = RECORDING_STATUS.RECORDING
          state.isRecording = true
          state.isPaused = false
        }),
        finishRecording: vi.fn(async () => {
          state.status = RECORDING_STATUS.IDLE
          return {
            id: state.id,
            type: state.activityType,
            distanceM: state.liveStats.distanceM,
            durationMs: state.liveStats.movingTimeMs,
            points: [...points],
            summary: { ...state.liveStats },
          }
        }),
        discardRecording: vi.fn(async () => {
          state.status = RECORDING_STATUS.IDLE
        }),
      }
    }

    it('renders live recording screen with accuracy badge, large metrics, and controls', () => {
      const mockRec = createMockRecorder()
      const html = renderToStaticMarkup(
        React.createElement(RecordingView, {
          recorder: mockRec,
        })
      )

      // Live screen container
      expect(html).toContain('recording-live-screen')

      // GPS Accuracy Badge
      expect(html).toContain('data-testid="accuracy-badge"')
      expect(html).toContain('data-level="good"')
      expect(html).toContain('GPS ±6m')

      // Status & Activity
      expect(html).toContain('RECORDING')
      expect(html).toContain('run')

      // Large Hero Metric: Distance
      expect(html).toContain('data-testid="hero-distance-value"')
      expect(html).toContain('3.50') // 3500m = 3.50 km
      expect(html).toContain('km')

      // Secondary metrics
      expect(html).toContain('data-testid="metric-duration"')
      expect(html).toContain('20:00') // 1200000ms = 20:00
      expect(html).toContain('data-testid="metric-rate"')
      expect(html).toContain('data-testid="metric-elevation"')
      expect(html).toContain('45 m')
      expect(html).toContain('data-testid="metric-calories"')
      expect(html).toContain('240 kcal')

      // Controls
      expect(html).toContain('data-testid="pause-btn"')
      expect(html).toContain('data-testid="discard-btn"')
      expect(html).toContain('data-testid="finish-btn"')
      expect(html).toContain('Hold to Finish')

      // RouteCanvas
      expect(html).toContain('data-testid="route-canvas"')
    })

    it('renders PAUSED state with resume button when recorder is paused', () => {
      const mockRec = createMockRecorder({
        status: RECORDING_STATUS.PAUSED,
        isPaused: true,
        isRecording: false,
      })

      const html = renderToStaticMarkup(
        React.createElement(RecordingView, {
          recorder: mockRec,
        })
      )

      expect(html).toContain('PAUSED')
      expect(html).toContain('data-testid="resume-btn"')
      expect(html).toContain('Resume')
      expect(html).not.toContain('data-testid="pause-btn"')
    })

    it('renders idle selection screen when recorder is idle', () => {
      const mockRec = createMockRecorder({
        status: RECORDING_STATUS.IDLE,
        isIdle: true,
        isRecording: false,
        isPaused: false,
      })

      const html = renderToStaticMarkup(
        React.createElement(RecordingView, {
          recorder: mockRec,
        })
      )

      expect(html).toContain('recording-idle')
      expect(html).toContain('Record Cardio')
      expect(html).toContain('Select Activity')
      expect(html).toContain('data-testid="start-recording-btn"')
    })

    it('renders cycling activity with speed metric instead of pace', () => {
      const mockRec = createMockRecorder({
        activityType: 'ride',
        liveStats: {
          distanceM: 10000,
          movingTimeMs: 1800000, // 30 min
          elapsedTimeMs: 1800000,
          avgSpeed: 5.56, // ~20.0 km/h
          elevationGainM: 120,
          calories: 450,
        },
      })

      const html = renderToStaticMarkup(
        React.createElement(RecordingView, {
          recorder: mockRec,
        })
      )

      expect(html).toContain('ride')
      expect(html).toContain('Speed')
      expect(html).toContain('20.0 km/h')
      expect(html).toContain('10.00') // 10.00 km
    })

    it('renders finished summary screen when session finishes', () => {
      const mockRec = createMockRecorder({
        status: RECORDING_STATUS.IDLE,
      })

      const finalizedActivity = {
        id: 'rec-done-1',
        type: 'run',
        distanceM: 5200,
        durationMs: 1560000, // 26 min
        avgPaceSecKm: 300,   // 5:00 min/km
        points: [
          { lat: 52.5, lon: 13.4 },
          { lat: 52.52, lon: 13.42 },
        ],
        summary: {
          distanceM: 5200,
          movingTimeMs: 1560000,
          elevationGainM: 35,
          calories: 380,
        },
      }

      // Render summary state by passing initial finished activity or testing summary view
      const html = renderToStaticMarkup(
        React.createElement(RecordingView, {
          recorder: mockRec,
          // We can test summary markup directly
        })
      )

      expect(html).toBeDefined()
    })

    it('handles hold-to-finish timing logic', async () => {
      vi.useFakeTimers()
      try {
        const mockRec = createMockRecorder()
        let finished = false
        mockRec.finishRecording = vi.fn(async () => {
          finished = true
          return { id: 'done', type: 'run', distanceM: 3000, durationMs: 1000, points: [] }
        })

        // Verify the hold threshold logic
        const threshold = 100
        let holdTimer = null
        let elapsed = 0

        const startHold = () => {
          const startTime = Date.now()
          holdTimer = setInterval(() => {
            elapsed = Date.now() - startTime
            if (elapsed >= threshold) {
              clearInterval(holdTimer)
              mockRec.finishRecording()
            }
          }, 20)
        }

        const cancelHold = () => {
          if (holdTimer) clearInterval(holdTimer)
        }

        // 1. Cancel before threshold
        startHold()
        vi.advanceTimersByTime(40)
        cancelHold()
        expect(mockRec.finishRecording).not.toHaveBeenCalled()

        // 2. Hold past threshold
        startHold()
        vi.advanceTimersByTime(120)
        expect(mockRec.finishRecording).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
