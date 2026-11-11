// Platform-neutral native cardio device adapter seam (Issue #38).
//
// Provides platform-agnostic abstractions for:
//   1. GPS location watching with start/stop lifecycle and fix events.
//   2. Track file persistence for active logs and <year>/<id> track files
//      (read, write, delete, append recovery log, clear recovery log).
//   3. Text-to-Speech (TTS) audio cues with music/audio ducking and stop controls.
//   4. In-memory test fake (`createMemoryCardioAdapter`) for unit/integration testing.

import { Capacitor } from '@capacitor/core'

export const RECOVERY_LOG_PATH = 'opengym-cardio-recovery.log'
export const DEFAULT_TRACKS_DIR = 'tracks'

/**
 * Normalizes track file paths by trimming, converting backslashes,
 * and stripping leading slashes.
 */
export function normalizeTrackPath(path) {
  if (!path) return ''
  let p = String(path).trim().replace(/\\/g, '/')
  return p.replace(/^\/+/, '')
}

/**
 * Normalizes a raw GPS fix object into consistent structure
 * with coords and top-level coordinates.
 */
export function normalizeFix(fixData = {}) {
  const latitude = fixData.latitude ?? fixData.coords?.latitude ?? 0
  const longitude = fixData.longitude ?? fixData.coords?.longitude ?? 0
  const altitude = fixData.altitude ?? fixData.coords?.altitude ?? null
  const accuracy = fixData.accuracy ?? fixData.coords?.accuracy ?? 5
  const altitudeAccuracy = fixData.altitudeAccuracy ?? fixData.coords?.altitudeAccuracy ?? null
  const heading = fixData.heading ?? fixData.coords?.heading ?? null
  const speed = fixData.speed ?? fixData.coords?.speed ?? 0
  const timestamp = fixData.timestamp ?? Date.now()

  const coords = {
    latitude,
    longitude,
    altitude,
    accuracy,
    altitudeAccuracy,
    heading,
    speed,
    ...(fixData.coords || {})
  }

  return {
    latitude,
    longitude,
    altitude,
    accuracy,
    altitudeAccuracy,
    heading,
    speed,
    timestamp,
    ...fixData,
    coords
  }
}

/**
 * Recovery log array with string and array compatibility methods.
 */
export class RecoveryLog extends Array {
  toString() {
    return this.join('\n')
  }

  valueOf() {
    return this.join('\n')
  }

  get text() {
    return this.join('\n')
  }

  get lines() {
    return [...this]
  }

  parsed() {
    return this.map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return line
      }
    })
  }

  split(sep = '\n') {
    return this.join('\n').split(sep)
  }

  trim() {
    return this.join('\n').trim()
  }

  includes(item, fromIndex) {
    if (super.includes(item, fromIndex)) return true
    return this.join('\n').includes(item)
  }
}

/**
 * Creates an in-memory test fake cardio adapter.
 */
export function createMemoryCardioAdapter(initial = {}) {
  const tracks = new Map(Object.entries(initial.tracks || {}))
  const recoveryLog = [...(initial.recoveryLog || [])]
  const spokenCues = [...(initial.spokenCues || [])]
  const watchers = new Map()
  let nextWatchId = 1
  let duckingState = Boolean(initial.isDucking)
  let speakingState = Boolean(initial.isSpeaking)

  function resolveTrackKey(path) {
    const norm = normalizeTrackPath(path)
    if (tracks.has(norm)) return norm
    if (!norm.endsWith('.json') && tracks.has(`${norm}.json`)) return `${norm}.json`
    if (norm.endsWith('.json') && tracks.has(norm.replace(/\.json$/, ''))) {
      return norm.replace(/\.json$/, '')
    }
    return norm
  }

  const adapter = {
    isMemory: true,

    get isDucking() {
      return duckingState
    },

    get isSpeaking() {
      return speakingState
    },

    get spokenCues() {
      return spokenCues
    },

    // --- GPS Watcher Subsystem ---
    startWatcher(opts, onFix, onError) {
      if (typeof opts === 'function') {
        onError = onFix
        onFix = opts
        opts = {}
      } else if (typeof onFix !== 'function' && typeof opts === 'function') {
        onFix = opts
        opts = {}
      }
      opts = opts || {}

      const watchId = nextWatchId++
      const stop = () => adapter.stopWatcher(watchId)

      const handle = {
        watchId,
        id: watchId,
        stop,
        toString: () => String(watchId),
        valueOf: () => watchId,
        [Symbol.toPrimitive]: hint => (hint === 'number' ? watchId : String(watchId))
      }

      watchers.set(watchId, { opts, onFix, onError, handle, stop })
      return handle
    },

    stopWatcher(target) {
      if (target === undefined || target === null) {
        if (watchers.size === 1) {
          const onlyId = watchers.keys().next().value
          watchers.delete(onlyId)
          return true
        }
        return false
      }
      const id = (typeof target === 'object' && (target.watchId ?? target.id)) ? (target.watchId ?? target.id) : target
      const numId = Number(id)
      const foundKey = watchers.has(id) ? id : (watchers.has(numId) ? numId : null)
      if (foundKey !== null) {
        watchers.delete(foundKey)
        return true
      }
      return false
    },

    simulateFix(fixData) {
      const fix = normalizeFix(fixData)
      for (const w of watchers.values()) {
        if (typeof w.onFix === 'function') {
          try {
            w.onFix(fix)
          } catch (err) {
            console.error('simulateFix callback error:', err)
          }
        }
      }
      return fix
    },

    emitFix(fixData) {
      return adapter.simulateFix(fixData)
    },

    simulateError(err) {
      const errorObj = typeof err === 'string' ? new Error(err) : (err || new Error('GPS signal error'))
      for (const w of watchers.values()) {
        if (typeof w.onError === 'function') {
          try {
            w.onError(errorObj)
          } catch (e) {
            console.error('simulateError callback error:', e)
          }
        }
      }
      return errorObj
    },

    emitError(err) {
      return adapter.simulateError(err)
    },

    getActiveWatchers() {
      return Array.from(watchers.values())
    },

    getActiveWatcherCount() {
      return watchers.size
    },

    // --- File I/O Subsystem ---
    async writeTrack(path, data) {
      const norm = normalizeTrackPath(path)
      tracks.set(norm, data)
      return true
    },

    async readTrack(path) {
      const key = resolveTrackKey(path)
      if (!tracks.has(key)) return null
      const stored = tracks.get(key)
      if (typeof stored === 'string') {
        try {
          const parsed = JSON.parse(stored)
          if (parsed && typeof parsed === 'object') {
            Object.defineProperty(parsed, 'toString', {
              value: () => stored,
              writable: true,
              configurable: true
            })
          }
          return parsed
        } catch {
          return stored
        }
      }
      if (stored && typeof stored === 'object') {
        const copy = (typeof structuredClone === 'function')
          ? structuredClone(stored)
          : JSON.parse(JSON.stringify(stored))
        Object.defineProperty(copy, 'toString', {
          value: () => JSON.stringify(stored),
          writable: true,
          configurable: true
        })
        return copy
      }
      return stored
    },

    async deleteTrack(path) {
      const key = resolveTrackKey(path)
      if (tracks.has(key)) {
        tracks.delete(key)
        return true
      }
      const norm = normalizeTrackPath(path)
      if (tracks.has(norm)) {
        tracks.delete(norm)
        return true
      }
      return false
    },

    async hasTrack(path) {
      const key = resolveTrackKey(path)
      return tracks.has(key)
    },

    async listTracks() {
      return Array.from(tracks.keys())
    },

    async appendRecoveryLog(line) {
      if (line === null || line === undefined) return false
      const str = typeof line === 'string' ? line : JSON.stringify(line)
      recoveryLog.push(str)
      return true
    },

    async readRecoveryLog() {
      return new RecoveryLog(...recoveryLog)
    },

    async clearRecoveryLog() {
      recoveryLog.length = 0
      return true
    },

    // --- Text-to-Speech Subsystem ---
    async speak(text, opts = {}) {
      const cue = {
        text: String(text),
        ducking: opts.ducking !== false,
        ...opts,
        timestamp: Date.now()
      }
      Object.defineProperty(cue, 'toString', { value: () => cue.text })
      Object.defineProperty(cue, 'valueOf', { value: () => cue.text })

      spokenCues.push(cue)
      speakingState = true
      if (cue.ducking) {
        duckingState = true
      }
      return cue
    },

    stopSpeaking() {
      speakingState = false
      duckingState = false
      return true
    },

    duckAudio(enabled = true) {
      duckingState = Boolean(enabled)
      return duckingState
    },

    getSpokenCues() {
      return [...spokenCues]
    },

    clearSpokenCues() {
      spokenCues.length = 0
    }
  }

  return adapter
}

/**
 * Creates a native / browser device cardio adapter.
 */
export function createNativeCardioAdapter(deps = {}) {
  let watchers = new Map()
  let nextWatchId = 1
  let duckingState = false
  let speakingState = false

  const isNative = deps.isNative ?? (function() {
    try {
      return Boolean(Capacitor?.isNativePlatform?.())
    } catch {
      return false
    }
  })()

  // Storage fallback for web
  const webStorage = deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null)
  const memoryFallback = createMemoryCardioAdapter()

  const adapter = {
    isMemory: false,

    get isDucking() {
      return duckingState
    },

    get isSpeaking() {
      return speakingState
    },

    startWatcher(opts, onFix, onError) {
      if (typeof opts === 'function') {
        onError = onFix
        onFix = opts
        opts = {}
      } else if (typeof onFix !== 'function' && typeof opts === 'function') {
        onFix = opts
        opts = {}
      }
      opts = opts || {}

      const watchId = nextWatchId++
      const geoOpts = {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 1000,
        ...opts
      }

      let nativeWatchId = null
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        try {
          nativeWatchId = navigator.geolocation.watchPosition(
            pos => {
              if (onFix) onFix(normalizeFix(pos))
            },
            err => {
              if (onError) onError(err)
            },
            geoOpts
          )
        } catch (e) {
          if (onError) onError(e)
        }
      } else {
        if (onError) onError(new Error('Geolocation is not supported on this platform'))
      }

      const stop = () => adapter.stopWatcher(watchId)
      const handle = {
        watchId,
        id: watchId,
        stop,
        toString: () => String(watchId),
        valueOf: () => watchId,
        [Symbol.toPrimitive]: hint => (hint === 'number' ? watchId : String(watchId))
      }

      watchers.set(watchId, { nativeWatchId, stop })
      return handle
    },

    stopWatcher(target) {
      if (target === undefined || target === null) {
        if (watchers.size === 1) {
          const onlyId = watchers.keys().next().value
          return adapter.stopWatcher(onlyId)
        }
        return false
      }
      const id = (typeof target === 'object' && (target.watchId ?? target.id)) ? (target.watchId ?? target.id) : target
      const entry = watchers.get(id) || watchers.get(Number(id))
      if (entry) {
        if (entry.nativeWatchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
          try {
            navigator.geolocation.clearWatch(entry.nativeWatchId)
          } catch {}
        }
        watchers.delete(id)
        watchers.delete(Number(id))
        return true
      }
      return false
    },

    async writeTrack(path, data) {
      const norm = normalizeTrackPath(path)
      if (isNative) {
        try {
          const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
          const raw = typeof data === 'string' ? data : JSON.stringify(data)
          await Filesystem.writeFile({
            path: norm,
            directory: Directory.Data,
            data: raw,
            encoding: Encoding.UTF8,
            recursive: true
          })
          return true
        } catch {}
      }

      if (webStorage) {
        const raw = typeof data === 'string' ? data : JSON.stringify(data)
        webStorage.setItem(`cardio_track:${norm}`, raw)
        return true
      }
      return memoryFallback.writeTrack(path, data)
    },

    async readTrack(path) {
      const norm = normalizeTrackPath(path)
      if (isNative) {
        try {
          const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
          let fileData = null
          try {
            const r = await Filesystem.readFile({
              path: norm,
              directory: Directory.Data,
              encoding: Encoding.UTF8
            })
            fileData = r.data
          } catch {
            if (!norm.endsWith('.json')) {
              const r = await Filesystem.readFile({
                path: `${norm}.json`,
                directory: Directory.Data,
                encoding: Encoding.UTF8
              })
              fileData = r.data
            }
          }
          if (fileData !== null) {
            try {
              return JSON.parse(fileData)
            } catch {
              return fileData
            }
          }
        } catch {}
      }

      if (webStorage) {
        let item = webStorage.getItem(`cardio_track:${norm}`)
        if (item === null && !norm.endsWith('.json')) {
          item = webStorage.getItem(`cardio_track:${norm}.json`)
        }
        if (item === null && norm.endsWith('.json')) {
          item = webStorage.getItem(`cardio_track:${norm.replace(/\.json$/, '')}`)
        }
        if (item !== null) {
          try {
            return JSON.parse(item)
          } catch {
            return item
          }
        }
        return null
      }
      return memoryFallback.readTrack(path)
    },

    async deleteTrack(path) {
      const norm = normalizeTrackPath(path)
      if (isNative) {
        try {
          const { Filesystem, Directory } = await import('@capacitor/filesystem')
          await Filesystem.deleteFile({
            path: norm,
            directory: Directory.Data
          })
          return true
        } catch {}
      }

      if (webStorage) {
        const key = `cardio_track:${norm}`
        let deleted = false
        if (webStorage.getItem(key) !== null) {
          webStorage.removeItem(key)
          deleted = true
        }
        if (webStorage.getItem(`${key}.json`) !== null) {
          webStorage.removeItem(`${key}.json`)
          deleted = true
        }
        const baseKey = key.replace(/\.json$/, '')
        if (webStorage.getItem(baseKey) !== null) {
          webStorage.removeItem(baseKey)
          deleted = true
        }
        return deleted
      }
      return memoryFallback.deleteTrack(path)
    },

    async appendRecoveryLog(line) {
      if (line === null || line === undefined) return false
      const str = (typeof line === 'string' ? line : JSON.stringify(line)) + '\n'
      if (isNative) {
        try {
          const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
          await Filesystem.appendFile({
            path: RECOVERY_LOG_PATH,
            directory: Directory.Data,
            data: str,
            encoding: Encoding.UTF8
          })
          return true
        } catch {}
      }

      if (webStorage) {
        const existing = webStorage.getItem('cardio_recovery_log') || ''
        webStorage.setItem('cardio_recovery_log', existing + str)
        return true
      }
      return memoryFallback.appendRecoveryLog(line)
    },

    async readRecoveryLog() {
      if (isNative) {
        try {
          const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
          const r = await Filesystem.readFile({
            path: RECOVERY_LOG_PATH,
            directory: Directory.Data,
            encoding: Encoding.UTF8
          })
          const lines = (r.data || '').split('\n').filter(Boolean)
          return new RecoveryLog(...lines)
        } catch {}
      }

      if (webStorage) {
        const text = webStorage.getItem('cardio_recovery_log') || ''
        const lines = text.split('\n').filter(Boolean)
        return new RecoveryLog(...lines)
      }
      return memoryFallback.readRecoveryLog()
    },

    async clearRecoveryLog() {
      if (isNative) {
        try {
          const { Filesystem, Directory } = await import('@capacitor/filesystem')
          await Filesystem.deleteFile({
            path: RECOVERY_LOG_PATH,
            directory: Directory.Data
          }).catch(() => {})
          return true
        } catch {}
      }

      if (webStorage) {
        webStorage.removeItem('cardio_recovery_log')
        return true
      }
      return memoryFallback.clearRecoveryLog()
    },

    async speak(text, opts = {}) {
      const cue = {
        text: String(text),
        ducking: opts.ducking !== false,
        ...opts,
        timestamp: Date.now()
      }
      speakingState = true
      if (cue.ducking) {
        duckingState = true
      }

      if (typeof window !== 'undefined' && window.speechSynthesis) {
        try {
          if (opts.interrupt !== false) {
            window.speechSynthesis.cancel()
          }
          const utterance = new SpeechSynthesisUtterance(cue.text)
          if (opts.rate) utterance.rate = opts.rate
          if (opts.pitch) utterance.pitch = opts.pitch
          if (opts.volume !== undefined) utterance.volume = opts.volume
          if (opts.lang) utterance.lang = opts.lang

          utterance.onend = () => {
            speakingState = false
            duckingState = false
            if (opts.onEnd) opts.onEnd()
          }
          utterance.onerror = (e) => {
            speakingState = false
            duckingState = false
            if (opts.onError) opts.onError(e)
          }

          window.speechSynthesis.speak(utterance)
        } catch {
          speakingState = false
          duckingState = false
        }
      }
      return cue
    },

    stopSpeaking() {
      speakingState = false
      duckingState = false
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel()
        } catch {}
      }
      return true
    },

    duckAudio(enabled = true) {
      duckingState = Boolean(enabled)
      return duckingState
    }
  }

  return adapter
}

let activeAdapter = null
const defaultMemoryAdapter = createMemoryCardioAdapter()

export function setCardioAdapter(adapter) {
  activeAdapter = adapter
}

export function getCardioAdapter() {
  if (activeAdapter) return activeAdapter
  if (typeof window !== 'undefined' && window.navigator?.geolocation) {
    try {
      return createNativeCardioAdapter()
    } catch {}
  }
  return defaultMemoryAdapter
}

// Top-level convenience wrappers
export function startWatcher(opts, onFix, onError) {
  return getCardioAdapter().startWatcher(opts, onFix, onError)
}

export function stopWatcher(watchId) {
  return getCardioAdapter().stopWatcher(watchId)
}

export function readTrack(path) {
  return getCardioAdapter().readTrack(path)
}

export function writeTrack(path, data) {
  return getCardioAdapter().writeTrack(path, data)
}

export function deleteTrack(path) {
  return getCardioAdapter().deleteTrack(path)
}

export function appendRecoveryLog(line) {
  return getCardioAdapter().appendRecoveryLog(line)
}

export function readRecoveryLog() {
  return getCardioAdapter().readRecoveryLog()
}

export function clearRecoveryLog() {
  return getCardioAdapter().clearRecoveryLog()
}

export function speak(text, opts) {
  return getCardioAdapter().speak(text, opts)
}

export function stopSpeaking() {
  return getCardioAdapter().stopSpeaking()
}
