import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  RECORDING_STATUS,
  DEFAULT_LIVE_STATS,
  compactTrackPoints,
  calculateLiveStats,
  CardioRecorder,
  createCardioRecorder,
  startRecording,
  pauseRecording,
  resumeRecording,
  finishRecording,
  discardRecording,
  onFix,
  getRecordingState,
  getLiveStats,
  isRecording,
  isPaused,
  isIdle,
  subscribe,
  recoverRecording,
} from './cardio-recording.js'

import {
  createMemoryCardioAdapter,
  setCardioAdapter,
  getCardioAdapter,
} from './cardio-adapter.js'

describe('Cardio Recording Lifecycle (Issue #53)', () => {
  let adapter

  beforeEach(() => {
    adapter = createMemoryCardioAdapter()
    setCardioAdapter(adapter)
  })

  describe('1. Pure helpers: compactTrackPoints & calculateLiveStats', () => {
    it('compactTrackPoints returns empty array for empty or non-array input', () => {
      expect(compactTrackPoints([])).toEqual([])
      expect(compactTrackPoints(null)).toEqual([])
      expect(compactTrackPoints(undefined)).toEqual([])
    })

    it('compactTrackPoints preserves endpoints on short tracks', () => {
      const pts = [
        { lat: 47.37, lon: 8.54 },
        { lat: 47.38, lon: 8.55 },
      ]
      const compacted = compactTrackPoints(pts)
      expect(compacted).toHaveLength(2)
      expect(compacted[0].lat).toBe(47.37)
      expect(compacted[1].lat).toBe(47.38)
    })

    it('compactTrackPoints reduces colinear points on straight lines', () => {
      // 5 points along a straight latitude line
      const pts = [
        { lat: 47.370, lon: 8.540 },
        { lat: 47.371, lon: 8.540 },
        { lat: 47.372, lon: 8.540 },
        { lat: 47.373, lon: 8.540 },
        { lat: 47.374, lon: 8.540 },
      ]
      const compacted = compactTrackPoints(pts, 10)
      expect(compacted.length).toBeLessThan(pts.length)
      expect(compacted[0].lat).toBe(47.370)
      expect(compacted[compacted.length - 1].lat).toBe(47.374)
    })

    it('calculateLiveStats returns default metrics for empty segments', () => {
      const stats = calculateLiveStats([])
      expect(stats).toEqual(DEFAULT_LIVE_STATS)
    })

    it('calculateLiveStats computes distance, moving time, pace, and calories for valid segments', () => {
      // 1 km run: 2 points ~1000m apart over 300 seconds (5 min) => 12 km/h, pace 5:00 min/km
      // 1 deg lat is ~111,000m => 0.009 deg lat ~ 1000.8m
      const t0 = 1710000000000
      const t1 = t0 + 300 * 1000
      const segments = [
        [
          { lat: 47.370000, lon: 8.540000, ele: 400, time: t0, speed: 3.33 },
          { lat: 47.379000, lon: 8.540000, ele: 420, time: t1, speed: 3.33 },
        ],
      ]

      const stats = calculateLiveStats(segments, {
        activity: 'run',
        unit: 'kg',
        weightKg: 70,
        startedAtMs: t0,
      })

      expect(stats.distanceM).toBeGreaterThan(950)
      expect(stats.distanceM).toBeLessThan(1050)
      expect(stats.movingTimeMs).toBe(300000)
      expect(stats.elapsedTimeMs).toBe(300000)
      expect(stats.avgSpeed).toBeCloseTo(3.33, 1)
      expect(stats.avgPace).toBeCloseTo(5.0, 1) // 5 min/km
      expect(stats.elevationGainM).toBe(20)
      expect(stats.calories).toBeGreaterThan(0)
    })
  })

  describe('2. CardioRecorder lifecycle transitions', () => {
    it('initializes in IDLE state with default values', () => {
      const recorder = createCardioRecorder({ adapter })
      expect(recorder.isIdle).toBe(true)
      expect(recorder.isRecording).toBe(false)
      expect(recorder.isPaused).toBe(false)
      expect(recorder.status).toBe(RECORDING_STATUS.IDLE)
      expect(recorder.getLiveStats()).toEqual(DEFAULT_LIVE_STATS)
    })

    it('transitions IDLE -> RECORDING on startRecording and attaches watcher', async () => {
      const recorder = createCardioRecorder({ adapter })
      const state = await recorder.startRecording({
        id: 'rec-test-1',
        type: 'run',
        startTime: '2026-06-15T08:00:00.000Z',
      })

      expect(state.status).toBe(RECORDING_STATUS.RECORDING)
      expect(recorder.isRecording).toBe(true)
      expect(recorder.isPaused).toBe(false)
      expect(recorder.isIdle).toBe(false)
      expect(state.id).toBe('rec-test-1')
      expect(state.activityType).toBe('run')
      expect(adapter.getActiveWatcherCount()).toBe(1)
    })

    it('transitions RECORDING -> PAUSED on pauseRecording and PAUSED -> RECORDING on resumeRecording', async () => {
      const recorder = createCardioRecorder({ adapter })
      await recorder.startRecording()

      expect(recorder.pauseRecording()).toBe(true)
      expect(recorder.isPaused).toBe(true)
      expect(recorder.isRecording).toBe(false)
      expect(recorder.status).toBe(RECORDING_STATUS.PAUSED)

      // Pausing again when already paused returns false
      expect(recorder.pauseRecording()).toBe(false)

      expect(recorder.resumeRecording()).toBe(true)
      expect(recorder.isRecording).toBe(true)
      expect(recorder.isPaused).toBe(false)
      expect(recorder.status).toBe(RECORDING_STATUS.RECORDING)

      // Resuming again when recording returns false
      expect(recorder.resumeRecording()).toBe(false)
    })

    it('finishRecording throws an error if called when idle', async () => {
      const recorder = createCardioRecorder({ adapter })
      await expect(recorder.finishRecording()).rejects.toThrow(/Cannot finish recording/)
    })

    it('discardRecording cleans up watcher, resets to IDLE, and clears recovery log', async () => {
      const recorder = createCardioRecorder({ adapter })
      await recorder.startRecording({ id: 'discard-me' })

      // Send a fix to put data in recovery log
      await adapter.simulateFix({ latitude: 47.37, longitude: 8.54, timestamp: 1710000000000 })
      expect((await adapter.readRecoveryLog()).length).toBeGreaterThan(0)

      const discarded = await recorder.discardRecording()
      expect(discarded).toBe(true)
      expect(recorder.isIdle).toBe(true)
      expect(recorder.isRecording).toBe(false)
      expect(adapter.getActiveWatcherCount()).toBe(0)
      expect((await adapter.readRecoveryLog()).length).toBe(0)
    })
  })

  describe('3. GPS Fix stream & liveStats calculation', () => {
    it('updates liveStats on valid GPS fixes', async () => {
      const recorder = createCardioRecorder({ adapter })
      const startTime = '2026-06-15T08:00:00.000Z'
      const startMs = Date.parse(startTime)

      await recorder.startRecording({
        id: 'run-live-1',
        type: 'run',
        startTime,
      })

      // Fix 1
      await adapter.simulateFix({
        latitude: 47.370000,
        longitude: 8.540000,
        altitude: 410,
        speed: 3.0,
        timestamp: startMs,
      })

      let stats = recorder.getLiveStats()
      expect(stats.distanceM).toBe(0)
      expect(stats.currentSpeed).toBe(3.0)

      // Fix 2: ~100m away, 30s later (approx 3.33 m/s)
      await adapter.simulateFix({
        latitude: 47.370900,
        longitude: 8.540000,
        altitude: 415,
        speed: 3.33,
        timestamp: startMs + 30000,
      })

      stats = recorder.getLiveStats()
      expect(stats.distanceM).toBeGreaterThan(90)
      expect(stats.distanceM).toBeLessThan(115)
      expect(stats.movingTimeMs).toBe(30000)
      expect(stats.elapsedTimeMs).toBe(30000)
      expect(stats.elevationGainM).toBeCloseTo(5, 1)
      expect(stats.currentSpeed).toBeCloseTo(3.33, 1)
      expect(stats.avgSpeed).toBeCloseTo(3.33, 1)
      expect(stats.currentPace).toBeCloseTo(5.0, 1)
      expect(stats.avgPace).toBeCloseTo(5.0, 1)
      expect(stats.calories).toBeGreaterThan(0)
    })

    it('ignores invalid GPS coordinates without crashing', async () => {
      const recorder = createCardioRecorder({ adapter })
      await recorder.startRecording()

      const res1 = await recorder.onFix({ latitude: null, longitude: 8.54 })
      expect(res1).toBeNull()

      const res2 = await recorder.onFix({ latitude: 95.0, longitude: 8.54 }) // lat > 90
      expect(res2).toBeNull()

      const res3 = await recorder.onFix({ latitude: 47.37, longitude: 200.0 }) // lon > 180
      expect(res3).toBeNull()

      expect(recorder.getState().pointsCount).toBe(0)
    })

    it('does not accumulate distance or moving time while PAUSED', async () => {
      const recorder = createCardioRecorder({ adapter })
      const startMs = 1710000000000

      await recorder.startRecording({
        id: 'run-pause-test',
        startTime: new Date(startMs).toISOString(),
      })

      // Fix 1 while recording
      await adapter.simulateFix({
        latitude: 47.370000,
        longitude: 8.540000,
        timestamp: startMs,
        speed: 3.0,
      })

      // Fix 2: 100m run
      await adapter.simulateFix({
        latitude: 47.370900,
        longitude: 8.540000,
        timestamp: startMs + 30000,
        speed: 3.33,
      })

      const distBeforePause = recorder.getLiveStats().distanceM
      expect(distBeforePause).toBeGreaterThan(90)

      // Pause recording
      recorder.pauseRecording()

      // Fix 3 while PAUSED (user moves 500m while paused)
      await adapter.simulateFix({
        latitude: 47.375400,
        longitude: 8.540000,
        timestamp: startMs + 90000,
        speed: 0,
      })

      // Distance should NOT have changed while paused
      expect(recorder.getLiveStats().distanceM).toBe(distBeforePause)

      // Resume recording at the new position
      recorder.resumeRecording()

      // Fix 4: first position after resume
      await adapter.simulateFix({
        latitude: 47.376300,
        longitude: 8.540000,
        timestamp: startMs + 120000,
        speed: 3.33,
      })

      // Fix 5: user runs another 100m after resume
      await adapter.simulateFix({
        latitude: 47.377200,
        longitude: 8.540000,
        timestamp: startMs + 150000,
        speed: 3.33,
      })

      // Only the new ~100m leg is added, NOT the 500m leap during pause!
      const distAfterResume = recorder.getLiveStats().distanceM
      expect(distAfterResume).toBeCloseTo(distBeforePause + 100, -1)
      expect(distAfterResume).toBeLessThan(distBeforePause + 250)
    })
  })

  describe('4. Recovery Log Streaming & Crash Recovery', () => {
    it('appends start event and GPS fixes to recovery log', async () => {
      const recorder = createCardioRecorder({ adapter })
      await recorder.startRecording({
        id: 'recovery-test-1',
        type: 'run',
        startTime: '2026-06-15T08:00:00.000Z',
      })

      let log = await adapter.readRecoveryLog()
      expect(log.length).toBe(1)
      expect(log.parsed()[0]).toMatchObject({
        event: 'start',
        id: 'recovery-test-1',
        type: 'run',
      })

      // Send 2 GPS fixes
      await adapter.simulateFix({
        latitude: 47.371,
        longitude: 8.541,
        altitude: 410,
        speed: 3.0,
      })
      await adapter.simulateFix({
        latitude: 47.372,
        longitude: 8.542,
        altitude: 412,
        speed: 3.2,
      })

      log = await adapter.readRecoveryLog()
      expect(log.length).toBe(3)
      const parsed = log.parsed()
      expect(parsed[1]).toMatchObject({ lat: 47.371, lon: 8.541, ele: 410 })
      expect(parsed[2]).toMatchObject({ lat: 47.372, lon: 8.542, ele: 412 })
    })

    it('recoverRecording reconstructs session state and metrics from recovery log', async () => {
      // Simulate existing recovery log in adapter
      await adapter.appendRecoveryLog({
        event: 'start',
        id: 'crashed-session-77',
        type: 'ride',
        startTime: '2026-06-15T10:00:00.000Z',
      })
      await adapter.appendRecoveryLog({
        lat: 47.370000,
        lon: 8.540000,
        ele: 400,
        time: 1710000000000,
        speed: 6.0,
      })
      await adapter.appendRecoveryLog({
        lat: 47.379000,
        lon: 8.540000,
        ele: 405,
        time: 1710000150000,
        speed: 6.6,
      })

      const recorder = createCardioRecorder({ adapter })
      const recoveredState = await recorder.recoverRecording()

      expect(recoveredState).not.toBeNull()
      expect(recoveredState.id).toBe('crashed-session-77')
      expect(recoveredState.activityType).toBe('ride')
      expect(recoveredState.isPaused).toBe(true)
      expect(recoveredState.pointsCount).toBe(2)
      expect(recoveredState.liveStats.distanceM).toBeGreaterThan(900)
    })
  })

  describe('5. finishRecording: RDP compaction, splits, file output & activity payload', () => {
    it('persists <year>/<id>.json file and clears recovery log on finish', async () => {
      const recorder = createCardioRecorder({ adapter })
      const startTime = '2026-06-15T08:00:00.000Z'
      const startMs = Date.parse(startTime)

      await recorder.startRecording({
        id: 'act-finish-101',
        type: 'run',
        startTime,
      })

      // Send 3 points along a route
      await adapter.simulateFix({
        latitude: 47.370000,
        longitude: 8.540000,
        altitude: 400,
        timestamp: startMs,
        speed: 3.33,
      })
      await adapter.simulateFix({
        latitude: 47.374500,
        longitude: 8.540000,
        altitude: 410,
        timestamp: startMs + 150000,
        speed: 3.33,
      })
      await adapter.simulateFix({
        latitude: 47.379000,
        longitude: 8.540000,
        altitude: 420,
        timestamp: startMs + 300000,
        speed: 3.33,
      })

      const activity = await recorder.finishRecording({
        notes: 'Great sunny morning tempo run',
        gearId: 'shoe_pegasus_40',
        rpe: 7,
      })

      // 1. Finalized activity payload matches openGym cardio format
      expect(activity.id).toBe('act-finish-101')
      expect(activity.type).toBe('run')
      expect(activity.startTime).toBe(startTime)
      expect(activity.distanceM).toBeGreaterThan(950)
      expect(activity.durationMs).toBe(300000)
      expect(activity.elevationGainM).toBe(20)
      expect(activity.avgPaceSecKm).toBeCloseTo(300, -1) // ~300 sec/km (5:00 min/km)
      expect(activity.avgSpeedKmh).toBeCloseTo(12, 0)     // ~12 km/h
      expect(activity.calories).toBeGreaterThan(0)
      expect(activity.notes).toBe('Great sunny morning tempo run')
      expect(activity.gearId).toBe('shoe_pegasus_40')
      expect(activity.rpe).toBe(7)
      expect(activity.trackPath).toBe('2026/act-finish-101.json')
      expect(Array.isArray(activity.points)).toBe(true)
      expect(Array.isArray(activity.splits)).toBe(true)

      // 2. Track file persistence in CardioAdapter
      expect(await adapter.hasTrack('2026/act-finish-101.json')).toBe(true)
      const trackFile = await adapter.readTrack('2026/act-finish-101.json')
      expect(trackFile).not.toBeNull()
      expect(trackFile.id).toBe('act-finish-101')
      expect(trackFile.type).toBe('run')
      expect(trackFile.points.length).toBeGreaterThanOrEqual(2)
      expect(trackFile.summary.distanceM).toBe(activity.distanceM)

      // 3. Recovery log cleared
      const log = await adapter.readRecoveryLog()
      expect(log.length).toBe(0)

      // 4. Recorder status reset to IDLE and watcher stopped
      expect(recorder.isIdle).toBe(true)
      expect(adapter.getActiveWatcherCount()).toBe(0)
    })

    it('logs activity to store when store is provided', async () => {
      const mockStore = {
        logCardioActivity: vi.fn(),
      }

      const recorder = createCardioRecorder({ adapter, store: mockStore })
      await recorder.startRecording({ id: 'store-test-act' })
      await adapter.simulateFix({ latitude: 47.37, longitude: 8.54, timestamp: 1710000000000 })

      await recorder.finishRecording()
      expect(mockStore.logCardioActivity).toHaveBeenCalledTimes(1)
      expect(mockStore.logCardioActivity.mock.calls[0][0].id).toBe('store-test-act')
    })
  })

  describe('6. Subscriptions and event notifications', () => {
    it('notifies subscribers on state changes and fixes', async () => {
      const recorder = createCardioRecorder({ adapter })
      const listener = vi.fn()
      const unsubscribe = recorder.subscribe(listener)

      await recorder.startRecording({ id: 'sub-test' })
      expect(listener).toHaveBeenCalled()

      const countAfterStart = listener.mock.calls.length

      await adapter.simulateFix({
        latitude: 47.37,
        longitude: 8.54,
        timestamp: 1710000000000,
      })
      expect(listener.mock.calls.length).toBeGreaterThan(countAfterStart)

      recorder.pauseRecording()
      expect(listener.mock.calls.pop()[0].status).toBe(RECORDING_STATUS.PAUSED)

      recorder.resumeRecording()
      expect(listener.mock.calls.pop()[0].status).toBe(RECORDING_STATUS.RECORDING)

      unsubscribe()
      const callsBeforeFinish = listener.mock.calls.length
      await recorder.finishRecording()
      expect(listener.mock.calls.length).toBe(callsBeforeFinish)
    })
  })

  describe('7. Singleton default exports', () => {
    it('supports module-level start, onFix, pause, resume, and finish', async () => {
      const state = await startRecording({
        id: 'singleton-act-1',
        type: 'walk',
        startTime: '2026-07-01T09:00:00.000Z',
      })

      expect(isRecording()).toBe(true)
      expect(isPaused()).toBe(false)
      expect(isIdle()).toBe(false)
      expect(state.id).toBe('singleton-act-1')

      await onFix({
        latitude: 47.370,
        longitude: 8.540,
        timestamp: 1710000000000,
        speed: 1.4,
      })

      const live = getLiveStats()
      expect(live.currentSpeed).toBe(1.4)

      expect(pauseRecording()).toBe(true)
      expect(isPaused()).toBe(true)

      expect(resumeRecording()).toBe(true)
      expect(isRecording()).toBe(true)

      const finished = await finishRecording()
      expect(finished.id).toBe('singleton-act-1')
      expect(isIdle()).toBe(true)
    })
  })
})
