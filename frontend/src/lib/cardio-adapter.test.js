import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMemoryCardioAdapter,
  createNativeCardioAdapter,
  getCardioAdapter,
  setCardioAdapter,
  normalizeTrackPath,
  normalizeFix,
  RecoveryLog,
  startWatcher,
  stopWatcher,
  readTrack,
  writeTrack,
  deleteTrack,
  appendRecoveryLog,
  readRecoveryLog,
  clearRecoveryLog,
  speak,
  stopSpeaking
} from './cardio-adapter.js'

describe('cardio-adapter', () => {
  beforeEach(() => {
    setCardioAdapter(null)
  })

  describe('normalizeTrackPath', () => {
    it('normalizes slashes and whitespace', () => {
      expect(normalizeTrackPath('  /2026/run-1.json  ')).toBe('2026/run-1.json')
      expect(normalizeTrackPath('\\2026\\run-1.json')).toBe('2026/run-1.json')
      expect(normalizeTrackPath('')).toBe('')
      expect(normalizeTrackPath(null)).toBe('')
    })
  })

  describe('normalizeFix', () => {
    it('normalizes coordinates and provides coords sub-object', () => {
      const fix = normalizeFix({ latitude: 47.3769, longitude: 8.5417, speed: 3.5 })
      expect(fix.latitude).toBe(47.3769)
      expect(fix.longitude).toBe(8.5417)
      expect(fix.speed).toBe(3.5)
      expect(fix.coords.latitude).toBe(47.3769)
      expect(fix.coords.longitude).toBe(8.5417)
      expect(fix.timestamp).toBeTypeOf('number')
    })

    it('preserves nested coords if provided', () => {
      const fix = normalizeFix({ coords: { latitude: 40.7128, longitude: -74.006, speed: 2.1 } })
      expect(fix.latitude).toBe(40.7128)
      expect(fix.longitude).toBe(-74.006)
      expect(fix.speed).toBe(2.1)
      expect(fix.coords.latitude).toBe(40.7128)
    })
  })

  describe('RecoveryLog', () => {
    it('behaves as both an Array and a string with helper methods', () => {
      const log = new RecoveryLog('{"lat":1}', '{"lat":2}')
      expect(Array.isArray(log)).toBe(true)
      expect(log.length).toBe(2)
      expect(log[0]).toBe('{"lat":1}')
      expect(log.toString()).toBe('{"lat":1}\n{"lat":2}')
      expect(log.text).toBe('{"lat":1}\n{"lat":2}')
      expect(log.trim()).toBe('{"lat":1}\n{"lat":2}')
      expect(log.split('\n')).toEqual(['{"lat":1}', '{"lat":2}'])
      expect(log.parsed()).toEqual([{ lat: 1 }, { lat: 2 }])
      expect(log.includes('{"lat":1}')).toBe(true)
      expect(log.includes('lat":2')).toBe(true)
    })
  })

  describe('createMemoryCardioAdapter', () => {
    describe('GPS watcher lifecycle', () => {
      it('starts watcher and receives simulated fixes', () => {
        const adapter = createMemoryCardioAdapter()
        const onFix = vi.fn()
        const handle = adapter.startWatcher({ enableHighAccuracy: true }, onFix)

        expect(handle.watchId).toBeDefined()
        expect(typeof handle.stop).toBe('function')
        expect(adapter.getActiveWatcherCount()).toBe(1)

        adapter.simulateFix({ latitude: 47.3769, longitude: 8.5417, speed: 3.2 })
        expect(onFix).toHaveBeenCalledTimes(1)
        expect(onFix).toHaveBeenCalledWith(expect.objectContaining({
          latitude: 47.3769,
          longitude: 8.5417,
          speed: 3.2,
          coords: expect.objectContaining({ latitude: 47.3769 })
        }))

        // Stop using handle.stop()
        handle.stop()
        expect(adapter.getActiveWatcherCount()).toBe(0)

        adapter.simulateFix({ latitude: 47.38, longitude: 8.55 })
        expect(onFix).toHaveBeenCalledTimes(1)
      })

      it('supports stopWatcher by id or handle', () => {
        const adapter = createMemoryCardioAdapter()
        const onFix1 = vi.fn()
        const onFix2 = vi.fn()

        const w1 = adapter.startWatcher(onFix1)
        const w2 = adapter.startWatcher({}, onFix2)

        expect(adapter.getActiveWatcherCount()).toBe(2)

        adapter.stopWatcher(w1.watchId)
        expect(adapter.getActiveWatcherCount()).toBe(1)

        adapter.stopWatcher(w2)
        expect(adapter.getActiveWatcherCount()).toBe(0)
      })

      it('dispatches simulated errors to onError handler', () => {
        const adapter = createMemoryCardioAdapter()
        const onFix = vi.fn()
        const onError = vi.fn()

        adapter.startWatcher({}, onFix, onError)
        adapter.simulateError('GPS disconnected')

        expect(onError).toHaveBeenCalledTimes(1)
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'GPS disconnected' }))
      })
    })

    describe('Track file persistence', () => {
      it('writes, reads, and deletes track files with path normalization', async () => {
        const adapter = createMemoryCardioAdapter()
        const trackData = {
          id: '101',
          startTime: 1710000000000,
          points: [{ lat: 47.37, lon: 8.54, time: 1710000000000 }]
        }

        await adapter.writeTrack('/2026/101.json', trackData)
        expect(await adapter.hasTrack('2026/101.json')).toBe(true)

        // Read by normalized path or without .json extension
        const loaded = await adapter.readTrack('2026/101.json')
        expect(loaded).toEqual(trackData)

        const loadedWithoutExt = await adapter.readTrack('2026/101')
        expect(loadedWithoutExt).toEqual(trackData)

        // Read nonexistent track
        expect(await adapter.readTrack('2026/999.json')).toBeNull()

        // List tracks
        const list = await adapter.listTracks()
        expect(list).toContain('2026/101.json')

        // Delete track
        const deleted = await adapter.deleteTrack('2026/101.json')
        expect(deleted).toBe(true)
        expect(await adapter.readTrack('2026/101.json')).toBeNull()
        expect(await adapter.deleteTrack('2026/101.json')).toBe(false)
      })

      it('reads string tracks and supports toString JSON coercion', async () => {
        const adapter = createMemoryCardioAdapter()
        const jsonStr = JSON.stringify({ id: '202', name: 'Morning run' })
        await adapter.writeTrack('2026/202.json', jsonStr)

        const loaded = await adapter.readTrack('2026/202.json')
        expect(loaded.id).toBe('202')
        expect(JSON.parse(loaded)).toEqual({ id: '202', name: 'Morning run' })
      })
    })

    describe('Active recovery log', () => {
      it('appends, reads, and clears recovery log lines', async () => {
        const adapter = createMemoryCardioAdapter()
        expect(await adapter.readRecoveryLog()).toHaveLength(0)

        await adapter.appendRecoveryLog('point-1')
        await adapter.appendRecoveryLog({ lat: 47.37, lon: 8.54 })

        const log = await adapter.readRecoveryLog()
        expect(log).toHaveLength(2)
        expect(log[0]).toBe('point-1')
        expect(log[1]).toBe('{"lat":47.37,"lon":8.54}')
        expect(log.toString()).toContain('point-1')

        await adapter.clearRecoveryLog()
        const emptyLog = await adapter.readRecoveryLog()
        expect(emptyLog).toHaveLength(0)
      })
    })

    describe('TTS speech and audio ducking', () => {
      it('records spoken cues and manages ducking state', async () => {
        const adapter = createMemoryCardioAdapter()
        expect(adapter.isSpeaking).toBe(false)
        expect(adapter.isDucking).toBe(false)

        await adapter.speak('Pace 5 minutes 30 seconds', { ducking: true })
        expect(adapter.spokenCues).toHaveLength(1)
        expect(adapter.spokenCues[0].text).toBe('Pace 5 minutes 30 seconds')
        expect(adapter.isSpeaking).toBe(true)
        expect(adapter.isDucking).toBe(true)

        adapter.stopSpeaking()
        expect(adapter.isSpeaking).toBe(false)
        expect(adapter.isDucking).toBe(false)
      })

      it('supports ducking: false option', async () => {
        const adapter = createMemoryCardioAdapter()
        await adapter.speak('Quiet cue', { ducking: false })
        expect(adapter.isSpeaking).toBe(true)
        expect(adapter.isDucking).toBe(false)
        adapter.stopSpeaking()
      })

      it('clears spoken cues history', async () => {
        const adapter = createMemoryCardioAdapter()
        await adapter.speak('Cue 1')
        await adapter.speak('Cue 2')
        expect(adapter.getSpokenCues()).toHaveLength(2)

        adapter.clearSpokenCues()
        expect(adapter.spokenCues).toHaveLength(0)
      })
    })
  })

  describe('createNativeCardioAdapter', () => {
    it('creates native adapter with fallback when APIs unavailable', async () => {
      const adapter = createNativeCardioAdapter()
      expect(adapter.isMemory).toBe(false)
      expect(adapter.isSpeaking).toBe(false)
      expect(adapter.isDucking).toBe(false)

      // File I/O fallback works
      await adapter.writeTrack('2026/test.json', { a: 1 })
      const read = await adapter.readTrack('2026/test.json')
      expect(read).toEqual({ a: 1 })
      await adapter.deleteTrack('2026/test.json')

      // Recovery log fallback works
      await adapter.appendRecoveryLog('line-a')
      const rec = await adapter.readRecoveryLog()
      expect(rec.length).toBeGreaterThanOrEqual(1)
      await adapter.clearRecoveryLog()

      // TTS works
      await adapter.speak('Test prompt', { ducking: true })
      adapter.stopSpeaking()
    })
  })

  describe('global adapter and top-level helper functions', () => {
    it('delegates to active adapter set via setCardioAdapter', async () => {
      const fake = createMemoryCardioAdapter()
      setCardioAdapter(fake)

      expect(getCardioAdapter()).toBe(fake)

      // Watcher
      const onFix = vi.fn()
      const w = startWatcher(onFix)
      fake.simulateFix({ latitude: 12.34, longitude: 56.78 })
      expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ latitude: 12.34 }))
      stopWatcher(w.watchId)

      // Track I/O
      await writeTrack('2026/top.json', { ok: true })
      expect(await readTrack('2026/top.json')).toEqual({ ok: true })
      await deleteTrack('2026/top.json')
      expect(await readTrack('2026/top.json')).toBeNull()

      // Recovery log
      await appendRecoveryLog('rec-1')
      const log = await readRecoveryLog()
      expect(log).toHaveLength(1)
      await clearRecoveryLog()
      expect(await readRecoveryLog()).toHaveLength(0)

      // TTS
      await speak('Global cue')
      expect(fake.spokenCues).toHaveLength(1)
      stopSpeaking()
    })
  })
})
