/**
 * Autonomous Speech Synthesis Module (Issue #88)
 *
 * Provides standalone Text-to-Speech (TTS) synthesis and audio ducking control
 * with pluggable memory and native Web Speech adapters, decoupled from GPS and Track I/O.
 */

/**
 * Creates an in-memory Speech adapter for deterministic testing.
 *
 * @param {Object} [initial={}]
 * @returns {Object} Memory speech adapter
 */
export function createMemorySpeechAdapter(initial = {}) {
  const spokenCues = [...(initial.spokenCues || [])]
  let duckingState = Boolean(initial.isDucking)
  let speakingState = Boolean(initial.isSpeaking)

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
 * Creates a native Web Speech API adapter for browser environments,
 * falling back gracefully if speech synthesis is unavailable.
 *
 * @returns {Object} Native speech adapter
 */
export function createNativeSpeechAdapter() {
  let duckingState = false
  let speakingState = false

  const adapter = {
    isMemory: false,

    get isDucking() {
      return duckingState
    },

    get isSpeaking() {
      return speakingState
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

let activeSpeechAdapter = null
const defaultMemoryAdapter = createMemorySpeechAdapter()

/**
 * Sets the active global speech adapter.
 *
 * @param {Object|null} adapter
 */
export function setSpeechAdapter(adapter) {
  activeSpeechAdapter = adapter
}

/**
 * Retrieves the active global speech adapter.
 *
 * @returns {Object}
 */
export function getSpeechAdapter() {
  if (activeSpeechAdapter) return activeSpeechAdapter
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      return createNativeSpeechAdapter()
    } catch {
      return defaultMemoryAdapter
    }
  }
  return defaultMemoryAdapter
}

/**
 * Synthesizes speech using the active speech adapter.
 *
 * @param {string} text
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
export function speak(text, opts) {
  return getSpeechAdapter().speak(text, opts)
}

/**
 * Halts any active speech and resets ducking on the active speech adapter.
 *
 * @returns {boolean}
 */
export function stopSpeaking() {
  return getSpeechAdapter().stopSpeaking()
}

/**
 * Controls music/audio ducking on the active speech adapter.
 *
 * @param {boolean} [enabled=true]
 * @returns {boolean}
 */
export function duckAudio(enabled = true) {
  return getSpeechAdapter().duckAudio(enabled)
}
