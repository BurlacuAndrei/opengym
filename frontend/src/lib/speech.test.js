import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  createMemorySpeechAdapter,
  createNativeSpeechAdapter,
  setSpeechAdapter,
  getSpeechAdapter,
  speak,
  stopSpeaking,
  duckAudio
} from './speech.js'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
  getCardioAdapter
} from './cardio-adapter.js'

describe('speech module (Issue #88)', () => {
  beforeEach(() => {
    setSpeechAdapter(null)
    setCardioAdapter(null)
  })

  afterEach(() => {
    setSpeechAdapter(null)
    setCardioAdapter(null)
    vi.restoreAllMocks()
  })

  describe('createMemorySpeechAdapter', () => {
    it('initializes with default or specified state', () => {
      const adapter = createMemorySpeechAdapter()
      expect(adapter.isMemory).toBe(true)
      expect(adapter.isSpeaking).toBe(false)
      expect(adapter.isDucking).toBe(false)
      expect(adapter.spokenCues).toEqual([])

      const initialized = createMemorySpeechAdapter({
        isSpeaking: true,
        isDucking: true,
        spokenCues: [{ text: 'Hello' }]
      })
      expect(initialized.isSpeaking).toBe(true)
      expect(initialized.isDucking).toBe(true)
      expect(initialized.spokenCues).toHaveLength(1)
    })

    it('records spoken cues and manages speaking/ducking lifecycle', async () => {
      const adapter = createMemorySpeechAdapter()
      const cue = await adapter.speak('Next move: Downward Dog', { ducking: true })

      expect(cue.text).toBe('Next move: Downward Dog')
      expect(cue.ducking).toBe(true)
      expect(cue.timestamp).toBeTypeOf('number')
      expect(String(cue)).toBe('Next move: Downward Dog')
      expect(adapter.isSpeaking).toBe(true)
      expect(adapter.isDucking).toBe(true)
      expect(adapter.spokenCues).toHaveLength(1)

      adapter.stopSpeaking()
      expect(adapter.isSpeaking).toBe(false)
      expect(adapter.isDucking).toBe(false)
    })

    it('supports ducking: false option', async () => {
      const adapter = createMemorySpeechAdapter()
      await adapter.speak('Soft announcement', { ducking: false })

      expect(adapter.isSpeaking).toBe(true)
      expect(adapter.isDucking).toBe(false)
    })

    it('supports manual duckAudio controls', () => {
      const adapter = createMemorySpeechAdapter()
      expect(adapter.duckAudio(true)).toBe(true)
      expect(adapter.isDucking).toBe(true)
      expect(adapter.duckAudio(false)).toBe(false)
      expect(adapter.isDucking).toBe(false)
    })

    it('manages spoken cues history', async () => {
      const adapter = createMemorySpeechAdapter()
      await adapter.speak('Cue 1')
      await adapter.speak('Cue 2')

      expect(adapter.getSpokenCues()).toHaveLength(2)
      adapter.clearSpokenCues()
      expect(adapter.spokenCues).toHaveLength(0)
    })
  })

  describe('createNativeSpeechAdapter', () => {
    it('creates native adapter with safe fallbacks when window.speechSynthesis is missing', async () => {
      const adapter = createNativeSpeechAdapter()
      expect(adapter.isMemory).toBe(false)
      expect(adapter.isSpeaking).toBe(false)
      expect(adapter.isDucking).toBe(false)

      const cue = await adapter.speak('Testing native speech fallback')
      expect(cue.text).toBe('Testing native speech fallback')
      adapter.stopSpeaking()
      expect(adapter.isSpeaking).toBe(false)
    })

    it('integrates with window.speechSynthesis when available', async () => {
      const cancelMock = vi.fn()
      const speakMock = vi.fn()
      const origWindow = globalThis.window

      // Mock window with speechSynthesis
      globalThis.window = {
        speechSynthesis: {
          cancel: cancelMock,
          speak: speakMock
        }
      }
      globalThis.SpeechSynthesisUtterance = class {
        constructor(text) {
          this.text = text
        }
      }

      try {
        const adapter = createNativeSpeechAdapter()
        await adapter.speak('Hello from mock speech', { rate: 1.2, ducking: true })

        expect(cancelMock).toHaveBeenCalled()
        expect(speakMock).toHaveBeenCalled()
        expect(adapter.isSpeaking).toBe(true)
        expect(adapter.isDucking).toBe(true)

        adapter.stopSpeaking()
        expect(cancelMock).toHaveBeenCalledTimes(2)
        expect(adapter.isSpeaking).toBe(false)
        expect(adapter.isDucking).toBe(false)
      } finally {
        globalThis.window = origWindow
      }
    })
  })

  describe('global speech adapter and top-level functions', () => {
    it('delegates speak, stopSpeaking, and duckAudio to active adapter', async () => {
      const mem = createMemorySpeechAdapter()
      setSpeechAdapter(mem)
      expect(getSpeechAdapter()).toBe(mem)

      await speak('Global test cue')
      expect(mem.spokenCues).toHaveLength(1)
      expect(mem.spokenCues[0].text).toBe('Global test cue')

      duckAudio(true)
      expect(mem.isDucking).toBe(true)

      stopSpeaking()
      expect(mem.isSpeaking).toBe(false)
      expect(mem.isDucking).toBe(false)
    })

    it('bridges setCardioAdapter to setSpeechAdapter for backwards compatibility', async () => {
      const cardioAdapter = createMemoryCardioAdapter()
      setCardioAdapter(cardioAdapter)

      // Speaking via speech module reaches the cardio adapter
      await speak('Cue dispatched via speech seam')
      expect(cardioAdapter.spokenCues).toHaveLength(1)
      expect(cardioAdapter.spokenCues[0].text).toBe('Cue dispatched via speech seam')
      expect(cardioAdapter.isSpeaking).toBe(true)

      stopSpeaking()
      expect(cardioAdapter.isSpeaking).toBe(false)
    })
  })
})
