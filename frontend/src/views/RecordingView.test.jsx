import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import RecordingView, {
  RECORDING_SPORTS,
  resolveDefaultGearForSport,
  finalizeRecordingLinks,
  FOLLOW_STATE_ROUTE_ID,
  resolveInitialRouteId,
  resolveFollowRoute,
  resolveFollowRouteTarget,
  evaluateRouteFollower,
  createRecordingRouteFollower,
  formatGpsError,
} from './RecordingView.jsx'
import { useStore, DEF } from '../store/useStore.js'
import { todayISO } from '../lib/format.js'
import { RECORDING_STATUS } from '../lib/cardio-recording.js'
import { createRouteFollower, formatOffCourseAlert } from '../lib/route-follower.js'

vi.mock('../store/useStore.js', async importOriginal => {
  const actual = await importOriginal()
  const useStoreMock = selector => {
    const s = actual.useStore.getState()
    return selector ? selector(s) : s
  }
  Object.assign(useStoreMock, actual.useStore)
  return { ...actual, useStore: useStoreMock }
})

if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} })
  }
}

describe('Pre-Start Cardio Recording Setup (Issue #99)', () => {
  beforeEach(() => {
    useStore.getInitialState = () => useStore.getState()
    useStore.setState({ S: JSON.parse(JSON.stringify(DEF)), user: null })
  })

  it('renders 6 sports, planned target selector, route selector, gear selector, and Web fallback shortcuts when idle', () => {
    const today = todayISO()
    const wd = new Date(today + 'T12:00:00').getDay()
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        cardioPlans: [
          { id: 'cp-1', type: 'run', day: wd, targetDistanceM: 8000, intervals: [{ type: 'work', durationSec: 120 }] }
        ],
        routes: [
          { id: 'rt-1', name: 'River Loop', distanceM: 5200 }
        ],
        gear: [
          { id: 'g-shoe', name: 'Pegasus 41', type: 'shoe', isDefault: true, retired: false },
          { id: 'g-bike', name: 'Canyon Road', type: 'bike', isDefault: true, retired: false }
        ]
      }
    })

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: '/record', search: '?route=rt-1', state: { followRouteId: 'rt-1', activityType: 'run' } }] },
        React.createElement(Routes, null, React.createElement(Route, { path: '/record', element: React.createElement(RecordingView) }))
      )
    )

    for (const sp of RECORDING_SPORTS) {
      expect(html).toContain(`data-testid="sport-btn-${sp}"`)
    }
    expect(html).toContain('data-testid="plan-selector"')
    expect(html).toContain('8 km')
    expect(html).toContain('data-testid="route-selector"')
    expect(html).toContain('River Loop')
    expect(html).toContain('data-testid="gear-selector"')
    expect(html).toContain('Pegasus 41')
    expect(html).toContain('data-testid="web-fallback-banner"')
    expect(html).toContain('Log Manual Cardio')
    expect(html).toContain('Import GPX')
  })

  it('gear selector excludes gear retired via isRetired, retired, or mixed flags', () => {
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        gear: [
          { id: 'g-active', name: 'Active Shoe', type: 'shoe', isDefault: true, isRetired: false },
          { id: 'g-iso', name: 'Retired Canonical', type: 'shoe', isRetired: true },
          { id: 'g-leg', name: 'Retired Legacy', type: 'shoe', retired: true },
          { id: 'g-mix', name: 'Retired Mixed', type: 'shoe', isRetired: false, retired: true },
          null,
          undefined
        ]
      }
    })

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/record'] },
        React.createElement(Routes, null, React.createElement(Route, { path: '/record', element: React.createElement(RecordingView) }))
      )
    )

    expect(html).toContain('Active Shoe')
    expect(html).not.toContain('Retired Canonical')
    expect(html).not.toContain('Retired Legacy')
    expect(html).not.toContain('Retired Mixed')
  })

  it('resolveDefaultGearForSport picks default non-retired gear matching sport category', () => {
    const gear = [
      null,
      undefined,
      { id: 's1', name: 'Old Shoe', type: 'shoe', isDefault: true, retired: true },
      { id: 's1b', name: 'Canonical Retired', type: 'shoe', isDefault: true, isRetired: true },
      { id: 's1c', name: 'Mixed Retired', type: 'shoe', isDefault: true, isRetired: false, retired: true },
      { id: 's2', name: 'Daily Trainer', type: 'shoe', isDefault: true, retired: false },
      { id: 'b1', name: 'Gravel Bike', type: 'bike', isDefault: true, retired: false }
    ]
    expect(resolveDefaultGearForSport(gear, 'run')).toBe('s2')
    expect(resolveDefaultGearForSport(gear, 'ride')).toBe('b1')
    expect(resolveDefaultGearForSport([], 'run')).toBe('')
    expect(resolveDefaultGearForSport(null, 'run')).toBe('')
    expect(resolveDefaultGearForSport(undefined, 'run')).toBe('')
  })

  it('finalizeRecordingLinks attributes distance to gear and marks linked cardioPlan completed', () => {
    const accFn = vi.fn()
    const updateActFn = vi.fn()
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        cardioPlans: [{ id: 'cp-run', type: 'run', targetDistanceM: 5000, completed: false }]
      }
    })

    finalizeRecordingLinks(
      { id: 'act-99', distanceM: 5120 },
      {
        selectedGearId: 'g-shoe',
        selectedPlanId: 'cp-run',
        accumulateGearFn: accFn,
        updateCardioActivityFn: updateActFn,
        updateStoreFn: useStore.getState().update
      }
    )

    expect(accFn).toHaveBeenCalledWith('g-shoe', 5120)
    expect(updateActFn).toHaveBeenCalledWith('act-99', { gearId: 'g-shoe' })
    const updatedPlan = useStore.getState().S.cardioPlans.find(p => p.id === 'cp-run')
    expect(updatedPlan.completed).toBe(true)
    expect(updatedPlan.completedActivityId).toBe('act-99')
  })

  it('finalizeRecordingLinks with gearAlreadyApplied skips gear accumulation/update while completing linked cardioPlan', () => {
    const accFn = vi.fn()
    const updateActFn = vi.fn()
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        cardioPlans: [{ id: 'cp-run-2', type: 'run', targetDistanceM: 5000, completed: false }]
      }
    })

    finalizeRecordingLinks(
      { id: 'act-100', distanceM: 5120, gearId: 'g-shoe' },
      {
        selectedGearId: 'g-shoe',
        selectedPlanId: 'cp-run-2',
        gearAlreadyApplied: true,
        accumulateGearFn: accFn,
        updateCardioActivityFn: updateActFn,
        updateStoreFn: useStore.getState().update
      }
    )

    expect(accFn).not.toHaveBeenCalled()
    expect(updateActFn).not.toHaveBeenCalled()
    const updatedPlan = useStore.getState().S.cardioPlans.find(p => p.id === 'cp-run-2')
    expect(updatedPlan.completed).toBe(true)
    expect(updatedPlan.completedActivityId).toBe('act-100')
  })
})

describe('Follow Route Off-Course Detection (Issue #2)', () => {
  // Reference segment along lat 37.7749, lon -122.4194 -> -122.4100 (~826m east)
  const routePts = [
    { lat: 37.7749, lon: -122.4194, ele: 10 },
    { lat: 37.7749, lon: -122.4100, ele: 15 },
  ]
  const onRoutePt = { lat: 37.7749, lon: -122.4150, time: 1000 }
  // ~222m north of route (> 100m threshold)
  const offRoutePt = { lat: 37.7769, lon: -122.4150, time: 2000 }

  beforeEach(() => {
    useStore.getInitialState = () => useStore.getState()
    useStore.setState({ S: JSON.parse(JSON.stringify(DEF)), user: null })
  })

  it('resolveFollowRoute resolves savedRoutes, followRouteState fallback, and handles empty/mismatched ids', () => {
    const saved = [
      { id: 'rt-1', name: 'Saved With Points', points: routePts },
      { id: 'rt-2', name: 'Metadata Only' },
      { id: 'rt-3', name: 'Empty Points', points: [] },
    ]
    const stateRoute = { id: 'rt-2', points: [onRoutePt] }

    expect(resolveFollowRoute('rt-1', saved, null)).toBe(routePts)
    expect(resolveFollowRoute('rt-2', saved, stateRoute)).toEqual([onRoutePt])
    expect(resolveFollowRoute('rt-3', saved, null)).toBeNull()
    expect(resolveFollowRoute('rt-other', saved, stateRoute)).toBeNull()
    expect(resolveFollowRoute('', saved, stateRoute)).toBeNull()
    expect(resolveFollowRoute('', saved, { points: routePts })).toBeNull()
    expect(resolveFollowRoute('', null, null)).toBeNull()
  })

  it('resolveInitialRouteId and resolveFollowRouteTarget handle id-less followRoute, explicit clear, and prevent metadata-only route leaks', () => {
    expect(FOLLOW_STATE_ROUTE_ID).toBe('__follow_route__')

    const saved = [
      { id: 'rt-1', name: 'Saved With Points', points: routePts },
      { id: 'rt-2', name: 'Metadata Only' },
    ]

    // resolveInitialRouteId
    expect(resolveInitialRouteId(null)).toBe('')
    expect(resolveInitialRouteId({})).toBe('')
    expect(resolveInitialRouteId({ state: { followRoute: { points: [] } } })).toBe('')
    expect(resolveInitialRouteId({ state: { followRoute: { points: routePts } } })).toBe(FOLLOW_STATE_ROUTE_ID)
    expect(resolveInitialRouteId({ state: { followRouteId: 'rt-2', followRoute: { points: routePts } } })).toBe('rt-2')
    expect(resolveInitialRouteId({ state: { followRoute: { id: 'rt-state', points: routePts } } })).toBe('rt-state')
    expect(resolveInitialRouteId({ search: '?route=rt-1' })).toBe('rt-1')

    // id-less mount
    const idLessLocation = { state: { followRoute: { name: 'Temp', points: routePts } } }
    expect(resolveFollowRouteTarget(FOLLOW_STATE_ROUTE_ID, saved, idLessLocation)).toEqual({
      routeObj: idLessLocation.state.followRoute,
      points: routePts,
    })

    // explicit "" clear
    expect(resolveFollowRouteTarget('', saved, idLessLocation)).toEqual({
      routeObj: null,
      points: null,
    })

    // metadata-only saved route switch without leak of id-less followRoute
    expect(resolveFollowRouteTarget('rt-2', saved, idLessLocation)).toEqual({
      routeObj: saved[1],
      points: null,
    })

    // followRouteId + id-less followRoute
    const explicitIdLocation = { state: { followRouteId: 'rt-2', followRoute: { points: [onRoutePt] } } }
    expect(resolveFollowRouteTarget('rt-2', saved, explicitIdLocation)).toEqual({
      routeObj: saved[1],
      points: [onRoutePt],
    })

    // null / empty / unknown
    expect(resolveFollowRouteTarget('', null, null)).toEqual({ routeObj: null, points: null })
    expect(resolveFollowRouteTarget('rt-missing', [], {})).toEqual({ routeObj: null, points: null })
  })

  it('evaluateRouteFollower resets on empty/null points, guards missing updatePosition, and updates with last point', () => {
    const reset = vi.fn()
    const updatePosition = vi.fn(pt => ({ isOffCourse: true, crossTrackDistance: 150, pt }))
    const mockFollower = { reset, updatePosition }

    expect(evaluateRouteFollower(null, [onRoutePt])).toBeNull()
    expect(evaluateRouteFollower(mockFollower, [])).toBeNull()
    expect(reset).toHaveBeenCalledTimes(1)
    expect(evaluateRouteFollower(mockFollower, null)).toBeNull()
    expect(reset).toHaveBeenCalledTimes(2)

    expect(evaluateRouteFollower(mockFollower, [null])).toBeNull()
    expect(evaluateRouteFollower({ reset }, [onRoutePt])).toBeNull()
    expect(updatePosition).not.toHaveBeenCalled()

    const res = evaluateRouteFollower(mockFollower, [onRoutePt, offRoutePt])
    expect(updatePosition).toHaveBeenCalledTimes(1)
    expect(updatePosition).toHaveBeenCalledWith(offRoutePt)
    expect(res).toEqual({ isOffCourse: true, crossTrackDistance: 150, pt: offRoutePt })

    const realFollower = createRouteFollower(routePts, { offCourseThresholdMeters: 100 })
    const onStatus = evaluateRouteFollower(realFollower, [onRoutePt])
    expect(onStatus.isOffCourse).toBe(false)
    expect(onStatus.crossTrackDistance).toBeLessThan(10)

    const offStatus = evaluateRouteFollower(realFollower, [offRoutePt])
    expect(offStatus.isOffCourse).toBe(true)
    expect(offStatus.crossTrackDistance).toBeGreaterThan(200)
  })

  it('renders off-route banner with crossTrackDistance when recording off-route, and hides when on-route', () => {
    const adapterSpeak = vi.fn()
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        routes: [{ id: 'rt-1', name: 'Bay Trail', distanceM: 826, points: routePts }],
      },
    })

    const expectedStatus = evaluateRouteFollower(
      createRouteFollower(routePts, { offCourseThresholdMeters: 100 }),
      [offRoutePt]
    )
    const expectedText = formatOffCourseAlert(expectedStatus.crossTrackDistance)
    expect(expectedText).toMatch(/^Off course: \d+ meters$/)
    expect(expectedText).not.toBe('Off course: 0 meters')

    const makeMockRecorder = (status, pts) => ({
      points: pts,
      adapter: { speak: adapterSpeak },
      getState: () => ({
        status,
        activityType: 'run',
        liveStats: { distanceM: 400, movingTimeMs: 120000, avgPace: 300, elevationGainM: 5, calories: 30 },
      }),
      getLiveStats: () => ({ distanceM: 400, movingTimeMs: 120000, avgPace: 300, elevationGainM: 5, calories: 30 }),
      subscribe: () => () => {},
    })

    const offRouteHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: '/record', search: '?route=rt-1', state: { followRouteId: 'rt-1' } }] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/record',
            element: React.createElement(RecordingView, {
              recorder: makeMockRecorder(RECORDING_STATUS.RECORDING, [offRoutePt]),
            }),
          })
        )
      )
    )

    expect(offRouteHtml).toContain('data-testid="off-route-banner"')
    expect(offRouteHtml).toContain(expectedText)
    // Initial SSR useState uses non-speaking follower
    expect(adapterSpeak).not.toHaveBeenCalled()

    const onRouteHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: '/record', state: { followRoute: { id: 'rt-state', points: routePts } } }] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/record',
            element: React.createElement(RecordingView, {
              recorder: makeMockRecorder(RECORDING_STATUS.RECORDING, [onRoutePt]),
            }),
          })
        )
      )
    )

    expect(onRouteHtml).toContain('data-testid="recording-live-screen"')
    expect(onRouteHtml).not.toContain('data-testid="off-route-banner"')

    const idleHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: '/record', search: '?route=rt-1' }] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/record',
            element: React.createElement(RecordingView, {
              recorder: makeMockRecorder(RECORDING_STATUS.IDLE, [offRoutePt]),
            }),
          })
        )
      )
    )

    expect(idleHtml).not.toContain('data-testid="off-route-banner"')

    const idLessRecordingHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: '/record', state: { followRoute: { name: 'Ad-hoc Loop', points: routePts } } }] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/record',
            element: React.createElement(RecordingView, {
              recorder: makeMockRecorder(RECORDING_STATUS.RECORDING, [offRoutePt]),
            }),
          })
        )
      )
    )

    expect(idLessRecordingHtml).toContain('data-testid="off-route-banner"')
    expect(idLessRecordingHtml).toContain(expectedText)
    expect(adapterSpeak).not.toHaveBeenCalled()

    const idLessIdleHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: '/record', state: { followRoute: { name: 'Ad-hoc Loop', points: routePts } } }] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/record',
            element: React.createElement(RecordingView, {
              recorder: makeMockRecorder(RECORDING_STATUS.IDLE, []),
            }),
          })
        )
      )
    )

    expect(idLessIdleHtml).toMatch(/<option[^>]*value="__follow_route__"[^>]*selected|selected[^>]*value="__follow_route__"/)
    expect(idLessIdleHtml).toContain('Ad-hoc Loop')

    const unsavedIdIdleHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: '/record', state: { followRoute: { id: 'rt-state', name: 'State Trail', distanceM: 1200, points: routePts } } }] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/record',
            element: React.createElement(RecordingView, {
              recorder: makeMockRecorder(RECORDING_STATUS.IDLE, []),
            }),
          })
        )
      )
    )

    expect(unsavedIdIdleHtml).toMatch(/<option[^>]*value="rt-state"[^>]*selected|selected[^>]*value="rt-state"/)
    expect(unsavedIdIdleHtml).toContain('State Trail')
  })

  it('createRecordingRouteFollower gates TTS on recording state, respects 30s throttle, voiceDucking/voiceCues, and resets throttle on pause/idle', async () => {
    const speakSpy = vi.fn().mockResolvedValue({ spoken: true })
    const adapter = { speak: speakSpy }

    const liveDeps = {
      rec: { adapter },
      S: { voiceCues: true, voiceDucking: true },
      recStatus: RECORDING_STATUS.RECORDING,
    }
    const follower = createRecordingRouteFollower(routePts, () => liveDeps)

    const status1 = evaluateRouteFollower(follower, [offRoutePt])
    await Promise.resolve()
    expect(status1.isOffCourse).toBe(true)
    expect(status1.offCourseAlert?.text).toBe(formatOffCourseAlert(status1.crossTrackDistance))
    expect(speakSpy).toHaveBeenCalledTimes(1)
    expect(speakSpy).toHaveBeenCalledWith(status1.offCourseAlert.text, { duck: true })

    // Throttled within 30s while recording
    const statusThrottled = evaluateRouteFollower(follower, [{ ...offRoutePt, time: 15000 }])
    await Promise.resolve()
    expect(statusThrottled.offCourseAlert).toBeNull()
    expect(speakSpy).toHaveBeenCalledTimes(1)

    // Fires again >= 30s later
    const statusAfter30s = evaluateRouteFollower(follower, [{ ...offRoutePt, time: 33000 }])
    await Promise.resolve()
    expect(statusAfter30s.offCourseAlert).not.toBeNull()
    expect(speakSpy).toHaveBeenCalledTimes(2)

    // voiceDucking: false
    speakSpy.mockClear()
    const noDuckFollower = createRecordingRouteFollower(routePts, {
      rec: { adapter },
      S: { voiceCues: true, voiceDucking: false },
      recStatus: RECORDING_STATUS.RECORDING,
    })
    const noDuckStatus = evaluateRouteFollower(noDuckFollower, [offRoutePt])
    await Promise.resolve()
    expect(speakSpy).toHaveBeenCalledWith(noDuckStatus.offCourseAlert.text, { duck: false })

    // voiceCues: false
    speakSpy.mockClear()
    const mutedFollower = createRecordingRouteFollower(routePts, {
      rec: { adapter },
      S: { voiceCues: false, voiceDucking: true },
      recStatus: RECORDING_STATUS.RECORDING,
    })
    evaluateRouteFollower(mutedFollower, [offRoutePt])
    await Promise.resolve()
    expect(speakSpy).not.toHaveBeenCalled()

    // PAUSED -> RECORDING resets throttle so resume speaks immediately even <30s
    speakSpy.mockClear()
    const pauseDeps = {
      rec: { adapter },
      S: { voiceCues: true, voiceDucking: true },
      recStatus: RECORDING_STATUS.PAUSED,
    }
    const pauseFollower = createRecordingRouteFollower(routePts, () => pauseDeps)
    evaluateRouteFollower(pauseFollower, [{ ...offRoutePt, time: 2000 }])
    await Promise.resolve()
    expect(speakSpy).not.toHaveBeenCalled()

    pauseDeps.recStatus = RECORDING_STATUS.RECORDING
    const resumedStatus = evaluateRouteFollower(pauseFollower, [{ ...offRoutePt, time: 5000 }])
    await Promise.resolve()
    expect(resumedStatus.offCourseAlert).not.toBeNull()
    expect(speakSpy).toHaveBeenCalledTimes(1)

    // IDLE -> RECORDING also resets throttle so start speaks immediately even <30s
    speakSpy.mockClear()
    const idleDeps = {
      rec: { adapter },
      S: { voiceCues: true, voiceDucking: true },
      recStatus: RECORDING_STATUS.IDLE,
    }
    const idleFollower = createRecordingRouteFollower(routePts, () => idleDeps)
    evaluateRouteFollower(idleFollower, [{ ...offRoutePt, time: 2000 }])
    await Promise.resolve()
    expect(speakSpy).not.toHaveBeenCalled()

    idleDeps.recStatus = RECORDING_STATUS.RECORDING
    const startedStatus = evaluateRouteFollower(idleFollower, [{ ...offRoutePt, time: 5000 }])
    await Promise.resolve()
    expect(startedStatus.offCourseAlert).not.toBeNull()
    expect(speakSpy).toHaveBeenCalledTimes(1)
  })
})

describe('RecordingView Pace Formatting (Issue #3)', () => {
  beforeEach(() => {
    useStore.getInitialState = () => useStore.getState()
  })

  it('formats liveStats.avgPace (min/unit) and finalized summary avgPaceSecKm in kg and lbs', () => {
    useStore.setState({ S: { ...JSON.parse(JSON.stringify(DEF)), unit: 'kg' } })
    const liveHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/record'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/record',
            element: React.createElement(RecordingView, {
              recorder: {
                points: [],
                getState: () => ({ status: RECORDING_STATUS.RECORDING, activityType: 'run' }),
                getLiveStats: () => ({ distanceM: 1000, movingTimeMs: 330000, avgPace: 5.5, elevationGainM: 10, calories: 60 }),
                subscribe: () => () => {},
              },
            }),
          })
        )
      )
    )
    expect(liveHtml).toContain('5:30 min/km')

    const summaryKgHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/record'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/record',
            element: React.createElement(RecordingView, {
              initialFinalizedActivity: {
                id: 'act-sum-1',
                type: 'run',
                distanceM: 5000,
                durationMs: 1500000,
                avgPaceSecKm: 300,
                points: [],
              },
            }),
          })
        )
      )
    )
    expect(summaryKgHtml).toContain('data-testid="recording-summary"')
    expect(summaryKgHtml).toContain('5:00 min/km')
    expect(summaryKgHtml).not.toContain('300:00')

    useStore.setState({ S: { ...JSON.parse(JSON.stringify(DEF)), unit: 'lbs' } })
    const summaryLbsHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/record'] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: '/record',
            element: React.createElement(RecordingView, {
              initialFinalizedActivity: {
                id: 'act-sum-2',
                type: 'run',
                distanceM: 5000,
                durationMs: 1500000,
                avgPaceSecKm: 300,
                points: [],
              },
            }),
          })
        )
      )
    )
    expect(summaryLbsHtml).toContain('8:03 min/mi')
    expect(summaryLbsHtml).not.toContain('300:00')
  })
})

describe('RecordingView GPS Error Handling (Issue #8 & #11)', () => {
  it('formatGpsError distinguishes permission denials (Android vs Web) from generic GPS failures', () => {
    expect(formatGpsError({ code: 1 }, { canOpenSettings: false })).toEqual({
      title: 'Location permission denied',
      message: 'Enable location access in your browser site settings to record GPS cardio, or log cardio manually.',
      isPermission: true,
    })
    expect(formatGpsError({ code: 1 }, { canOpenSettings: true })).toEqual({
      title: 'Location permission denied',
      message: 'Open Settings → Permissions → Location to allow location access for GPS cardio, or log cardio manually.',
      isPermission: true,
    })
    expect(formatGpsError(new Error('Permission denied by user'), { canOpenSettings: false })).toEqual({
      title: 'Location permission denied',
      message: 'Enable location access in your browser site settings to record GPS cardio, or log cardio manually.',
      isPermission: true,
    })
    expect(formatGpsError(new Error('Not allowed'), { canOpenSettings: true })).toEqual({
      title: 'Location permission denied',
      message: 'Open Settings → Permissions → Location to allow location access for GPS cardio, or log cardio manually.',
      isPermission: true,
    })
    expect(formatGpsError(new Error('Geolocation is not supported on this platform'))).toEqual({
      title: 'GPS unavailable',
      message: 'Could not start GPS tracking on this device. Try again or log cardio manually.',
      isPermission: false,
    })
    expect(formatGpsError(null)).toEqual({
      title: 'GPS unavailable',
      message: 'Could not start GPS tracking on this device. Try again or log cardio manually.',
      isPermission: false,
    })
  })

  it('returns to idle, shows error banner with Log Manual Cardio & Dismiss, and skips IntervalRunner start on GPS failure', async () => {
    vi.resetModules()

    const hooks = []
    let hookIdx = 0
    let pendingEffects = []
    const effectCleanups = []
    const openManualSpy = vi.fn()
    const runnerStartSpy = vi.fn().mockResolvedValue(undefined)
    const runnerUpdateSpy = vi.fn().mockResolvedValue(undefined)

    const depsChanged = (prev, next) =>
      !prev || !next || prev.length !== next.length || next.some((d, i) => !Object.is(d, prev[i]))

    vi.doMock('react', async importOriginal => {
      const actual = await importOriginal()
      return {
        ...actual,
        useState(init) {
          const idx = hookIdx++
          if (hooks[idx] === undefined) {
            hooks[idx] = typeof init === 'function' ? init() : init
          }
          const setState = val => {
            hooks[idx] = typeof val === 'function' ? val(hooks[idx]) : val
          }
          return [hooks[idx], setState]
        },
        useRef(init) {
          const idx = hookIdx++
          if (hooks[idx] === undefined) {
            hooks[idx] = { current: init }
          }
          return hooks[idx]
        },
        useCallback(fn, deps) {
          const idx = hookIdx++
          const prev = hooks[idx]
          if (!prev || depsChanged(prev.deps, deps)) {
            hooks[idx] = { value: fn, deps }
          }
          return hooks[idx].value
        },
        useEffect(fn, deps) {
          const idx = hookIdx++
          const prev = hooks[idx]
          if (!prev || depsChanged(prev.deps, deps)) {
            pendingEffects.push({ idx, fn, deps })
          }
        },
      }
    })

    vi.doMock('react-router-dom', async importOriginal => {
      const actual = await importOriginal()
      return {
        ...actual,
        useNavigate: () => vi.fn(),
        useLocation: () => ({ state: null }),
      }
    })

    vi.doMock('../lib/wakelock.js', () => ({
      useWakeLock: vi.fn(),
    }))

    vi.doMock('../components/ManualCardioSheet.jsx', () => ({
      openManualCardioSheet: openManualSpy,
    }))

    vi.doMock('../lib/interval-runner.js', () => ({
      createIntervalRunner: vi.fn(() => ({
        status: 'idle',
        splits: [],
        start: runnerStartSpy,
        update: runnerUpdateSpy,
      })),
    }))

    try {
      const { useStore: storeMod, DEF: defState } = await import('../store/useStore.js')
      storeMod.getInitialState = () => storeMod.getState()
      storeMod.setState({ S: JSON.parse(JSON.stringify(defState)), user: null })

      const { createCardioRecorder } = await import('../lib/cardio-recording.js')
      const { default: IsolatedRecordingView } = await import('./RecordingView.jsx')

      const stopSpeakingSpy = vi.fn()
      const stopWatcherSpy = vi.fn()
      const failingAdapter = {
        startWatcher: vi.fn((_opts, _onFix, onError) => {
          const err = new Error('Location permission denied')
          err.fatal = true
          onError(err)
          return { watchId: 1 }
        }),
        stopWatcher: stopWatcherSpy,
        clearRecoveryLog: vi.fn().mockResolvedValue(true),
        appendRecoveryLog: vi.fn().mockResolvedValue(true),
        stopSpeaking: stopSpeakingSpy,
      }

      const recorder = createCardioRecorder({ adapter: failingAdapter })
      const startSpy = vi.spyOn(recorder, 'startRecording')

      const renderTree = () => {
        hookIdx = 0
        pendingEffects = []
        const tree = IsolatedRecordingView({
          recorder,
          intervalSteps: [{ type: 'work', durationSec: 60 }],
        })
        for (const eff of pendingEffects) {
          if (typeof effectCleanups[eff.idx] === 'function') effectCleanups[eff.idx]()
          hooks[eff.idx] = { deps: eff.deps }
          effectCleanups[eff.idx] = eff.fn()
        }
        return tree
      }

      const findEl = (node, pred) => {
        if (!node || typeof node !== 'object') return null
        if (Array.isArray(node)) {
          for (const item of node) {
            const found = findEl(item, pred)
            if (found) return found
          }
          return null
        }
        if (pred(node)) return node
        return findEl(node.props?.children, pred)
      }

      const textOf = node => {
        if (node == null || typeof node === 'boolean') return ''
        if (typeof node === 'string' || typeof node === 'number') return String(node)
        if (Array.isArray(node)) return node.map(textOf).join(' ')
        return textOf(node.props?.children)
      }

      let tree = renderTree()
      expect(findEl(tree, n => n.props?.['data-testid'] === 'recording-idle')).not.toBeNull()
      expect(findEl(tree, n => n.props?.['data-testid'] === 'recording-error-banner')).toBeNull()

      const startBtn = findEl(tree, n => n.props?.['data-testid'] === 'start-recording-btn')
      expect(startBtn).not.toBeNull()

      await startBtn.props.onClick()

      expect(startSpy).toHaveBeenCalledWith(
        expect.objectContaining({ onError: expect.any(Function) })
      )
      expect(recorder.isIdle).toBe(true)
      expect(stopWatcherSpy).toHaveBeenCalledTimes(1)
      expect(stopSpeakingSpy).toHaveBeenCalledTimes(1)
      expect(runnerStartSpy).not.toHaveBeenCalled()

      tree = renderTree()
      expect(findEl(tree, n => n.props?.['data-testid'] === 'recording-idle')).not.toBeNull()

      const banner = findEl(tree, n => n.props?.['data-testid'] === 'recording-error-banner')
      expect(banner).not.toBeNull()
      expect(banner.props?.role).toBe('alert')
      expect(textOf(banner)).toContain('Location permission denied')
      expect(findEl(banner, n => n.props?.['data-testid'] === 'open-settings-btn')).toBeNull()

      const manualBtn = findEl(banner, n => textOf(n).trim() === 'Log Manual Cardio' && typeof n.props?.onClick === 'function')
      const dismissBtn = findEl(banner, n => textOf(n).trim() === 'Dismiss' && typeof n.props?.onClick === 'function')
      expect(manualBtn).not.toBeNull()
      expect(dismissBtn).not.toBeNull()

      manualBtn.props.onClick()
      expect(openManualSpy).toHaveBeenCalledTimes(1)

      dismissBtn.props.onClick()
      tree = renderTree()
      expect(findEl(tree, n => n.props?.['data-testid'] === 'recording-error-banner')).toBeNull()

      for (const cleanup of effectCleanups) {
        if (typeof cleanup === 'function') cleanup()
      }
    } finally {
      vi.doUnmock('react')
      vi.doUnmock('react-router-dom')
      vi.doUnmock('../lib/wakelock.js')
      vi.doUnmock('../components/ManualCardioSheet.jsx')
      vi.doUnmock('../lib/interval-runner.js')
      vi.resetModules()
    }
  })

  it('renders Open Settings on Android, invokes openLocationSettings, and auto-clears banner when permission is granted on resume', async () => {
    vi.resetModules()

    const hooks = []
    let hookIdx = 0
    let pendingEffects = []
    const effectCleanups = []
    const resumeCallbacks = []
    const removeListenerSpy = vi.fn()
    const openSettingsSpy = vi.fn().mockResolvedValue({ opened: true })
    let permissionState = 'denied'
    const checkPermissionsSpy = vi.fn(async () => ({ location: permissionState }))

    const hadCached = Object.prototype.hasOwnProperty.call(globalThis, '__opengymBackgroundLocation')
    const prevCached = globalThis.__opengymBackgroundLocation
    globalThis.__opengymBackgroundLocation = {
      openSettings: openSettingsSpy,
      checkPermissions: checkPermissionsSpy,
    }

    const depsChanged = (prev, next) =>
      !prev || !next || prev.length !== next.length || next.some((d, i) => !Object.is(d, prev[i]))

    vi.doMock('react', async importOriginal => {
      const actual = await importOriginal()
      return {
        ...actual,
        useState(init) {
          const idx = hookIdx++
          if (hooks[idx] === undefined) {
            hooks[idx] = typeof init === 'function' ? init() : init
          }
          const setState = val => {
            hooks[idx] = typeof val === 'function' ? val(hooks[idx]) : val
          }
          return [hooks[idx], setState]
        },
        useRef(init) {
          const idx = hookIdx++
          if (hooks[idx] === undefined) {
            hooks[idx] = { current: init }
          }
          return hooks[idx]
        },
        useCallback(fn, deps) {
          const idx = hookIdx++
          const prev = hooks[idx]
          if (!prev || depsChanged(prev.deps, deps)) {
            hooks[idx] = { value: fn, deps }
          }
          return hooks[idx].value
        },
        useEffect(fn, deps) {
          const idx = hookIdx++
          const prev = hooks[idx]
          if (!prev || depsChanged(prev.deps, deps)) {
            pendingEffects.push({ idx, fn, deps })
          }
        },
      }
    })

    vi.doMock('react-router-dom', async importOriginal => {
      const actual = await importOriginal()
      return {
        ...actual,
        useNavigate: () => vi.fn(),
        useLocation: () => ({ state: null }),
      }
    })

    vi.doMock('@capacitor/core', async importOriginal => {
      const actual = await importOriginal()
      return {
        ...actual,
        Capacitor: {
          ...actual.Capacitor,
          isNativePlatform: () => true,
          getPlatform: () => 'android',
        },
      }
    })

    vi.doMock('@capacitor/app', () => ({
      App: {
        addListener: vi.fn((event, cb) => {
          if (event === 'resume') resumeCallbacks.push(cb)
          return Promise.resolve({ remove: removeListenerSpy })
        }),
      },
    }))

    vi.doMock('../lib/wakelock.js', () => ({
      useWakeLock: vi.fn(),
    }))

    vi.doMock('../components/ManualCardioSheet.jsx', () => ({
      openManualCardioSheet: vi.fn(),
    }))

    vi.doMock('../lib/interval-runner.js', () => ({
      createIntervalRunner: vi.fn(() => ({
        status: 'idle',
        splits: [],
        start: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      })),
    }))

    try {
      const { useStore: storeMod, DEF: defState } = await import('../store/useStore.js')
      storeMod.getInitialState = () => storeMod.getState()
      storeMod.setState({ S: JSON.parse(JSON.stringify(defState)), user: null })

      const { createCardioRecorder } = await import('../lib/cardio-recording.js')
      const { default: IsolatedRecordingView } = await import('./RecordingView.jsx')

      const recorder = createCardioRecorder({
        adapter: {
          startWatcher: vi.fn((_opts, _onFix, onError) => {
            const err = new Error('Location permission denied')
            err.fatal = true
            onError(err)
            return { watchId: 1 }
          }),
          stopWatcher: vi.fn(),
          clearRecoveryLog: vi.fn().mockResolvedValue(true),
          appendRecoveryLog: vi.fn().mockResolvedValue(true),
          stopSpeaking: vi.fn(),
        },
      })

      const renderTree = () => {
        hookIdx = 0
        pendingEffects = []
        const tree = IsolatedRecordingView({ recorder })
        for (const eff of pendingEffects) {
          if (typeof effectCleanups[eff.idx] === 'function') effectCleanups[eff.idx]()
          hooks[eff.idx] = { deps: eff.deps }
          effectCleanups[eff.idx] = eff.fn()
        }
        return tree
      }

      const findEl = (node, pred) => {
        if (!node || typeof node !== 'object') return null
        if (Array.isArray(node)) {
          for (const item of node) {
            const found = findEl(item, pred)
            if (found) return found
          }
          return null
        }
        if (pred(node)) return node
        return findEl(node.props?.children, pred)
      }

      const textOf = node => {
        if (node == null || typeof node === 'boolean') return ''
        if (typeof node === 'string' || typeof node === 'number') return String(node)
        if (Array.isArray(node)) return node.map(textOf).join(' ')
        return textOf(node.props?.children)
      }

      let tree = renderTree()
      const startBtn = findEl(tree, n => n.props?.['data-testid'] === 'start-recording-btn')
      await startBtn.props.onClick()

      tree = renderTree()
      const banner = findEl(tree, n => n.props?.['data-testid'] === 'recording-error-banner')
      expect(banner).not.toBeNull()
      expect(textOf(banner)).toContain('Permissions → Location')

      const settingsBtn = findEl(banner, n => n.props?.['data-testid'] === 'open-settings-btn')
      expect(settingsBtn).not.toBeNull()
      expect(textOf(settingsBtn).trim()).toBe('Open Settings')
      expect(settingsBtn.props?.style?.minHeight).toBe(44)

      await settingsBtn.props.onClick()
      expect(openSettingsSpy).toHaveBeenCalledTimes(1)
      expect(resumeCallbacks).toHaveLength(1)

      // Resume while still denied keeps the error banner visible
      await resumeCallbacks[0]()
      tree = renderTree()
      expect(findEl(tree, n => n.props?.['data-testid'] === 'recording-error-banner')).not.toBeNull()

      // Resume after granting location permission auto-clears the banner
      permissionState = 'granted'
      await resumeCallbacks[0]()
      tree = renderTree()
      expect(findEl(tree, n => n.props?.['data-testid'] === 'recording-error-banner')).toBeNull()
      await Promise.resolve()
      expect(removeListenerSpy).toHaveBeenCalledTimes(1)

      for (const cleanup of effectCleanups) {
        if (typeof cleanup === 'function') cleanup()
      }
    } finally {
      if (hadCached) {
        globalThis.__opengymBackgroundLocation = prevCached
      } else {
        delete globalThis.__opengymBackgroundLocation
      }
      vi.doUnmock('react')
      vi.doUnmock('react-router-dom')
      vi.doUnmock('@capacitor/core')
      vi.doUnmock('@capacitor/app')
      vi.doUnmock('../lib/wakelock.js')
      vi.doUnmock('../components/ManualCardioSheet.jsx')
      vi.doUnmock('../lib/interval-runner.js')
      vi.resetModules()
    }
  })
})
