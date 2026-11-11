import { describe, it, expect, beforeEach } from 'vitest'
import {
  ACTIVE_LOG_FILENAME,
  normalizePoint,
  serializeRecoveryPoint,
  serializeRecoveryEvent,
  appendRecoveryPoint,
  appendRecoveryEvent,
  parseRecoveryLog,
  checkRecoveryLog,
  resumeRecoveredSession,
  finishRecoveredSession,
  discardRecoveredSession,
  clearRecoveryLog,
} from './cardio-recovery.js'
import {
  createMemoryCardioAdapter,
  RecoveryLog,
} from './cardio-adapter.js'
import {
  createCardioRecorder,
  RECORDING_STATUS,
} from './cardio-recording.js'

describe('Cardio Recovery Subsystem (Issue #63)', () => {
  let adapter

  beforeEach(() => {
    adapter = createMemoryCardioAdapter()
  })

  describe('1. Stream Serialization & Append Log', () => {
    it('defines ACTIVE_LOG_FILENAME constant', () => {
      expect(ACTIVE_LOG_FILENAME).toBe('active.jsonl')
    })

    it('normalizes GPS coordinates into standard point format', () => {
      const normalized = normalizePoint({
        latitude: 47.37123456,
        longitude: 8.54123456,
        altitude: 405.67,
        timestamp: 1710000000000,
        speed: 3.456,
        accuracy: 4.89,
        heading: 180.12,
      })

      expect(normalized).toEqual({
        lat: 47.371235,
        lon: 8.541235,
        ele: 405.7,
        time: 1710000000000,
        speed: 3.46,
        accuracy: 4.9,
        heading: 180.1,
      })
    })

    it('serializes a GPS fix point to a single-line JSON string', () => {
      const json = serializeRecoveryPoint({
        lat: 47.37,
        lon: 8.54,
        ele: 400,
        time: 1710000000000,
      })

      expect(typeof json).toBe('string')
      expect(json.includes('\n')).toBe(false)
      const parsed = JSON.parse(json)
      expect(parsed).toMatchObject({ lat: 47.37, lon: 8.54, ele: 400 })
    })

    it('throws TypeError if serializeRecoveryPoint is given non-object', () => {
      expect(() => serializeRecoveryPoint(null)).toThrow(TypeError)
      expect(() => serializeRecoveryPoint(undefined)).toThrow(TypeError)
    })

    it('serializes recovery events (start, pause, resume) to single-line JSON', () => {
      const json = serializeRecoveryEvent('start', {
        id: 'rec-test-1',
        type: 'run',
        startTime: '2026-06-15T08:00:00.000Z',
      })

      const parsed = JSON.parse(json)
      expect(parsed.event).toBe('start')
      expect(parsed.id).toBe('rec-test-1')
      expect(parsed.type).toBe('run')
      expect(typeof parsed.timestamp).toBe('number')
    })

    it('appends serialized point lines and events to adapter recovery log', async () => {
      await appendRecoveryEvent(adapter, 'start', { id: 'sess-1', type: 'run' })
      await appendRecoveryPoint(adapter, { lat: 47.37, lon: 8.54, time: 1710000000000 })
      await appendRecoveryPoint(adapter, { lat: 47.371, lon: 8.541, time: 1710000005000 })

      const log = await adapter.readRecoveryLog()
      expect(log.length).toBe(3)

      const parsed = log.parsed()
      expect(parsed[0].event).toBe('start')
      expect(parsed[1].lat).toBe(47.37)
      expect(parsed[2].lat).toBe(47.371)
    })
  })

  describe('2. Fault Tolerance & Corrupted Line Handling', () => {
    it('gracefully tolerates a truncated/partial last JSON line caused by a crash', () => {
      const logContent = [
        '{"event":"start","id":"crash-1","type":"run","startTime":"2026-06-15T08:00:00.000Z"}',
        '{"lat":47.370000,"lon":8.540000,"ele":400,"time":1710000000000,"speed":3.0}',
        '{"lat":47.371000,"lon":8.541000,"ele":402,"time":1710000005000,"speed":3.2}',
        '{"lat":47.372000,"lon":8.542000,"ele', // Partial line on abrupt crash
      ].join('\n')

      const result = parseRecoveryLog(logContent)

      expect(result.startMeta).toMatchObject({ id: 'crash-1', type: 'run' })
      expect(result.points).toHaveLength(2)
      expect(result.points[0].lat).toBe(47.37)
      expect(result.points[1].lat).toBe(47.371)
      expect(result.corruptedLinesCount).toBe(1)
      expect(result.totalLinesCount).toBe(4)
    })

    it('tolerates corrupted or garbage lines in the middle of the log', () => {
      const lines = [
        '{"event":"start","id":"crash-2","type":"ride"}',
        'CORRUPT_BUFFER_GARBAGE_LINE!@#$',
        '{"lat":47.370000,"lon":8.540000,"time":1710000000000}',
        '{ invalid json: true',
        '{"lat":47.372000,"lon":8.542000,"time":1710000010000}',
      ]

      const result = parseRecoveryLog(lines)

      expect(result.startMeta.id).toBe('crash-2')
      expect(result.points).toHaveLength(2)
      expect(result.corruptedLinesCount).toBe(2)
      expect(result.totalLinesCount).toBe(5)
    })

    it('handles empty log, blank lines, and null input safely', () => {
      expect(parseRecoveryLog('')).toEqual({
        startMeta: null,
        points: [],
        segments: [],
        events: [],
        corruptedLinesCount: 0,
        totalLinesCount: 0,
      })

      expect(parseRecoveryLog(null)).toEqual({
        startMeta: null,
        points: [],
        segments: [],
        events: [],
        corruptedLinesCount: 0,
        totalLinesCount: 0,
      })

      const blankLinesResult = parseRecoveryLog('\n  \n\n\t\n')
      expect(blankLinesResult.points).toHaveLength(0)
      expect(blankLinesResult.corruptedLinesCount).toBe(0)
    })

    it('partitions track points into segments when pause and resume events occur', () => {
      const lines = [
        '{"event":"start","id":"multi-seg-1","type":"run"}',
        '{"lat":47.370000,"lon":8.540000,"time":1710000000000}',
        '{"lat":47.371000,"lon":8.541000,"time":1710000005000}',
        '{"event":"pause","time":1710000010000}',
        '{"event":"resume","time":1710000060000}',
        '{"lat":47.372000,"lon":8.542000,"time":1710000065000}',
        '{"lat":47.373000,"lon":8.543000,"time":1710000070000}',
      ]

      const result = parseRecoveryLog(lines)
      expect(result.points).toHaveLength(4)
      expect(result.segments).toHaveLength(2)
      expect(result.segments[0]).toHaveLength(2)
      expect(result.segments[1]).toHaveLength(2)
    })
  })

  describe('3. Boot Recovery Check (checkRecoveryLog)', () => {
    it('returns null when recovery log is empty', async () => {
      const session = await checkRecoveryLog(adapter)
      expect(session).toBeNull()
    })

    it('returns null when recovery log contains only invalid/corrupted data', async () => {
      await adapter.appendRecoveryLog('CORRUPTED_LINE_1')
      await adapter.appendRecoveryLog('{ bad json')
      const session = await checkRecoveryLog(adapter)
      expect(session).toBeNull()
    })

    it('reconstructs session with start event and points', async () => {
      await adapter.appendRecoveryLog({
        event: 'start',
        id: 'session-reconstructed-1',
        type: 'run',
        startTime: '2026-06-15T08:00:00.000Z',
      })
      await adapter.appendRecoveryLog({
        lat: 47.370000,
        lon: 8.540000,
        ele: 400,
        time: 1710000000000,
        speed: 3.0,
      })
      await adapter.appendRecoveryLog({
        lat: 47.379000,
        lon: 8.540000,
        ele: 405,
        time: 1710000300000,
        speed: 3.3,
      })

      const session = await checkRecoveryLog(adapter)

      expect(session).not.toBeNull()
      expect(session.id).toBe('session-reconstructed-1')
      expect(session.activityType).toBe('run')
      expect(session.pointsCount).toBe(2)
      expect(session.liveStats.distanceM).toBeGreaterThan(900)
      expect(session.liveStats.movingTimeMs).toBeGreaterThan(0)
      expect(session.corruptedLinesCount).toBe(0)
      expect(typeof session.resume).toBe('function')
      expect(typeof session.finish).toBe('function')
      expect(typeof session.discard).toBe('function')
    })

    it('reconstructs session even if start event is missing, inferring from GPS points', async () => {
      await adapter.appendRecoveryLog({
        lat: 47.370000,
        lon: 8.540000,
        ele: 400,
        time: 1710000000000,
      })
      await adapter.appendRecoveryLog({
        lat: 47.371000,
        lon: 8.541000,
        ele: 402,
        time: 1710000010000,
      })

      const session = await checkRecoveryLog(adapter)

      expect(session).not.toBeNull()
      expect(session.id).toBeDefined()
      expect(session.activityType).toBe('run')
      expect(session.pointsCount).toBe(2)
      expect(session.startTime).toBe(new Date(1710000000000).toISOString())
    })

    it('handles start event with 0 points (immediate crash after starting)', async () => {
      await adapter.appendRecoveryLog({
        event: 'start',
        id: 'early-crash-session',
        type: 'ride',
        startTime: '2026-06-15T09:00:00.000Z',
      })

      const session = await checkRecoveryLog(adapter)

      expect(session).not.toBeNull()
      expect(session.id).toBe('early-crash-session')
      expect(session.activityType).toBe('ride')
      expect(session.pointsCount).toBe(0)
      expect(session.liveStats.distanceM).toBe(0)
    })
  })

  describe('4. Recovery Options: Resume Recording', () => {
    it('resumes interrupted recording into a CardioRecorder instance in RECORDING state', async () => {
      await adapter.appendRecoveryLog({
        event: 'start',
        id: 'resume-session-1',
        type: 'run',
        startTime: '2026-06-15T08:00:00.000Z',
      })
      await adapter.appendRecoveryLog({
        lat: 47.370000,
        lon: 8.540000,
        ele: 400,
        time: 1710000000000,
      })
      await adapter.appendRecoveryLog({
        lat: 47.375000,
        lon: 8.540000,
        ele: 402,
        time: 1710000150000,
      })

      const session = await checkRecoveryLog(adapter)
      expect(session).not.toBeNull()

      const recorder = createCardioRecorder({ adapter })
      await session.resume({ recorder, autoResume: true })

      expect(recorder.id).toBe('resume-session-1')
      expect(recorder.activityType).toBe('run')
      expect(recorder.status).toBe(RECORDING_STATUS.RECORDING)
      expect(recorder.points).toHaveLength(2)
      expect(recorder.liveStats.distanceM).toBeGreaterThan(500)

      // Send a new fix to the resumed recorder
      await adapter.simulateFix({
        latitude: 47.380000,
        longitude: 8.540000,
        altitude: 405,
        timestamp: 1710000300000,
      })

      expect(recorder.points).toHaveLength(3)
      expect(recorder.liveStats.distanceM).toBeGreaterThan(1000)
    })

    it('supports resuming in PAUSED state when autoResume is false', async () => {
      await adapter.appendRecoveryLog({
        event: 'start',
        id: 'paused-resume-session',
        type: 'walk',
      })
      await adapter.appendRecoveryLog({
        lat: 47.370000,
        lon: 8.540000,
        time: 1710000000000,
      })

      const session = await checkRecoveryLog(adapter)
      const recorder = await resumeRecoveredSession(session, {
        adapter,
        autoResume: false,
      })

      expect(recorder.status).toBe(RECORDING_STATUS.PAUSED)
      expect(recorder.points).toHaveLength(1)
    })
  })

  describe('5. Recovery Options: Finish & Save Recovered Points', () => {
    it('finishes recovered session: writes track file, clears log, and returns activity payload', async () => {
      const startTime = '2026-06-15T08:00:00.000Z'
      const startMs = Date.parse(startTime)

      await adapter.appendRecoveryLog({
        event: 'start',
        id: 'finish-recovery-act-99',
        type: 'run',
        startTime,
      })
      await adapter.appendRecoveryLog({
        lat: 47.370000,
        lon: 8.540000,
        ele: 400,
        time: startMs,
      })
      await adapter.appendRecoveryLog({
        lat: 47.379000,
        lon: 8.540000,
        ele: 405,
        time: startMs + 300000,
      })

      const session = await checkRecoveryLog(adapter)
      expect(session).not.toBeNull()

      const activity = await session.finish({ notes: 'Recovered after crash' })

      expect(activity.id).toBe('finish-recovery-act-99')
      expect(activity.type).toBe('run')
      expect(activity.startTime).toBe(startTime)
      expect(activity.notes).toBe('Recovered after crash')
      expect(activity.distanceM).toBeGreaterThan(900)
      expect(activity.trackPath).toBe('2026/finish-recovery-act-99.json')

      // Verify track file was written to adapter
      const trackFile = await adapter.readTrack('2026/finish-recovery-act-99.json')
      expect(trackFile).not.toBeNull()
      expect(trackFile.id).toBe('finish-recovery-act-99')
      expect(trackFile.points.length).toBeGreaterThanOrEqual(1)

      // Verify recovery log was cleared
      const remainingLog = await adapter.readRecoveryLog()
      expect(remainingLog.length).toBe(0)

      // Subsequent checkRecoveryLog returns null
      const checkAfter = await checkRecoveryLog(adapter)
      expect(checkAfter).toBeNull()
    })

    it('logs activity to store when store is provided in options', async () => {
      const loggedActivities = []
      const mockStore = {
        logCardioActivity: act => loggedActivities.push(act),
      }

      await adapter.appendRecoveryLog({
        event: 'start',
        id: 'store-logged-act',
        type: 'ride',
      })
      await adapter.appendRecoveryLog({
        lat: 47.370000,
        lon: 8.540000,
        time: 1710000000000,
      })

      const session = await checkRecoveryLog(adapter)
      await finishRecoveredSession(session, { adapter, store: mockStore })

      expect(loggedActivities).toHaveLength(1)
      expect(loggedActivities[0].id).toBe('store-logged-act')
      expect(loggedActivities[0].type).toBe('ride')
    })
  })

  describe('6. Recovery Options: Discard & Cleanup', () => {
    it('discards recovered session and clears recovery log', async () => {
      await adapter.appendRecoveryLog({
        event: 'start',
        id: 'discard-session',
        type: 'run',
      })
      await adapter.appendRecoveryLog({
        lat: 47.370000,
        lon: 8.540000,
        time: 1710000000000,
      })

      const session = await checkRecoveryLog(adapter)
      expect(session).not.toBeNull()

      const discarded = await session.discard()
      expect(discarded).toBe(true)

      const remainingLog = await adapter.readRecoveryLog()
      expect(remainingLog.length).toBe(0)

      expect(await checkRecoveryLog(adapter)).toBeNull()
    })

    it('clearRecoveryLog function clears recovery log directly on adapter', async () => {
      await adapter.appendRecoveryLog('line-1')
      await adapter.appendRecoveryLog('line-2')

      expect((await adapter.readRecoveryLog()).length).toBe(2)
      await clearRecoveryLog(adapter)
      expect((await adapter.readRecoveryLog()).length).toBe(0)
    })
  })

  describe('7. End-to-End Crash & Recovery Scenario', () => {
    it('simulates active session crash mid-write, boot check recovery, and clean finish', async () => {
      // Step 1: Active recording starts
      await appendRecoveryEvent(adapter, 'start', {
        id: 'e2e-crash-act',
        type: 'run',
        startTime: '2026-06-15T07:30:00.000Z',
      })

      // Step 2: Multiple GPS fixes streamed into active append log
      const startMs = Date.parse('2026-06-15T07:30:00.000Z')
      for (let i = 0; i < 5; i++) {
        await appendRecoveryPoint(adapter, {
          latitude: 47.370 + i * 0.002,
          longitude: 8.540,
          altitude: 400 + i,
          timestamp: startMs + i * 10000,
          speed: 3.2,
        })
      }

      // Step 3: Hard crash happens during write of 6th point (truncated partial line)
      await adapter.appendRecoveryLog('{"lat":47.380000,"lon":8.540000,"ele":406,"time":1710000060000,"speed":3.2,"acc')

      // Step 4: Boot check runs on next app launch
      const recoveredSession = await checkRecoveryLog(adapter)

      expect(recoveredSession).not.toBeNull()
      expect(recoveredSession.id).toBe('e2e-crash-act')
      expect(recoveredSession.activityType).toBe('run')
      expect(recoveredSession.pointsCount).toBe(5)
      expect(recoveredSession.corruptedLinesCount).toBe(1) // Truncated crash line safely ignored
      expect(recoveredSession.liveStats.distanceM).toBeGreaterThan(800)

      // Step 5: User chooses to finish & save recovered points
      const savedActivity = await recoveredSession.finish({ notes: 'Crash recovered!' })

      expect(savedActivity.id).toBe('e2e-crash-act')
      expect(savedActivity.points.length).toBeGreaterThanOrEqual(2)

      // Step 6: Log is cleaned up; no ghost recovery on next boot
      const rebootCheck = await checkRecoveryLog(adapter)
      expect(rebootCheck).toBeNull()
    })
  })
})
