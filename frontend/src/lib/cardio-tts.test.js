import { describe, it, expect, beforeEach, vi } from 'vitest'

if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: k => { delete store[k] },
    clear: () => { store = {} },
  }
}

import {
  isVoiceCuesEnabled,
  isImperialUnit,
  formatDurationSpoken,
  formatDistanceSpoken,
  formatPaceSpoken,
  formatSplitCue,
  speakSplitCue,
  announceSplit,
} from './cardio-tts.js'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
} from './cardio-adapter.js'
import { useStore } from '../store/useStore.js'

describe('cardio-tts', () => {
  let memoryAdapter

  beforeEach(() => {
    setCardioAdapter(null)
    memoryAdapter = createMemoryCardioAdapter()
    setCardioAdapter(memoryAdapter)
    vi.clearAllMocks()
  })

  describe('isVoiceCuesEnabled', () => {
    it('defaults to true when undefined or null', () => {
      expect(isVoiceCuesEnabled()).toBe(true)
      expect(isVoiceCuesEnabled(undefined)).toBe(true)
      expect(isVoiceCuesEnabled(null)).toBe(true)
      expect(isVoiceCuesEnabled({})).toBe(true)
    })

    it('respects boolean input directly', () => {
      expect(isVoiceCuesEnabled(true)).toBe(true)
      expect(isVoiceCuesEnabled(false)).toBe(false)
    })

    it('respects voiceCues in settings object or store state S', () => {
      expect(isVoiceCuesEnabled({ voiceCues: true })).toBe(true)
      expect(isVoiceCuesEnabled({ voiceCues: false })).toBe(false)
      expect(isVoiceCuesEnabled({ sound: true, voiceCues: false })).toBe(false)
      expect(isVoiceCuesEnabled({ sound: false, voiceCues: true })).toBe(true)
    })
  })

  describe('isImperialUnit', () => {
    it('identifies imperial units correctly', () => {
      expect(isImperialUnit('lbs')).toBe(true)
      expect(isImperialUnit('mi')).toBe(true)
      expect(isImperialUnit('imperial')).toBe(true)
      expect(isImperialUnit('kg')).toBe(false)
      expect(isImperialUnit('km')).toBe(false)
      expect(isImperialUnit('')).toBe(false)
      expect(isImperialUnit(null)).toBe(false)
    })
  })

  describe('formatDurationSpoken', () => {
    it('formats minutes and seconds into natural spoken words', () => {
      expect(formatDurationSpoken(312)).toBe('5 minutes 12 seconds')
      expect(formatDurationSpoken(60)).toBe('1 minute')
      expect(formatDurationSpoken(120)).toBe('2 minutes')
      expect(formatDurationSpoken(1)).toBe('1 second')
      expect(formatDurationSpoken(45)).toBe('45 seconds')
      expect(formatDurationSpoken(300)).toBe('5 minutes')
      expect(formatDurationSpoken(61)).toBe('1 minute 1 second')
      expect(formatDurationSpoken(0)).toBe('0 seconds')
    })

    it('supports includeZeroSeconds option', () => {
      expect(formatDurationSpoken(300, { includeZeroSeconds: true })).toBe('5 minutes 0 seconds')
      expect(formatDurationSpoken(60, { includeZeroSeconds: true })).toBe('1 minute 0 seconds')
    })
  })

  describe('formatDistanceSpoken', () => {
    it('formats metric distances with singular/plural kilometer words', () => {
      // Meters input
      expect(formatDistanceSpoken(3000, 'kg')).toBe('3 kilometers')
      expect(formatDistanceSpoken(1000, 'kg')).toBe('1 kilometer')
      expect(formatDistanceSpoken(3500, 'kg')).toBe('3.5 kilometers')
      // Direct unit values
      expect(formatDistanceSpoken(3, 'kg')).toBe('3 kilometers')
      expect(formatDistanceSpoken(1, 'kg')).toBe('1 kilometer')
      expect(formatDistanceSpoken(5.2, 'kg')).toBe('5.2 kilometers')
    })

    it('formats imperial distances with singular/plural mile words', () => {
      // Meters input
      expect(formatDistanceSpoken(4828.032, 'lbs')).toBe('3 miles')
      expect(formatDistanceSpoken(1609.344, 'lbs')).toBe('1 mile')
      // Direct unit values
      expect(formatDistanceSpoken(3, 'lbs')).toBe('3 miles')
      expect(formatDistanceSpoken(1, 'lbs')).toBe('1 mile')
      expect(formatDistanceSpoken(2.5, 'mi')).toBe('2.5 miles')
    })
  })

  describe('formatPaceSpoken', () => {
    it('formats metric pace in minutes and seconds per kilometer', () => {
      expect(formatPaceSpoken(312, 'kg')).toBe('5 minutes 12 seconds per kilometer')
      expect(formatPaceSpoken(5.2, 'kg', { inMinutes: true })).toBe('5 minutes 12 seconds per kilometer')
      expect(formatPaceSpoken(300, 'kg')).toBe('5 minutes per kilometer')
    })

    it('formats imperial pace in minutes and seconds per mile', () => {
      expect(formatPaceSpoken(312, 'lbs')).toBe('5 minutes 12 seconds per mile')
      expect(formatPaceSpoken(510, 'lbs')).toBe('8 minutes 30 seconds per mile')
    })
  })

  describe('formatSplitCue (Issue #64 exact cue specification)', () => {
    it('announces metric split completion matching Issue #64 example verbatim', () => {
      // Example: "Split 3. 5 minutes 12 seconds per kilometer. Total distance 3 kilometers."
      const cue = formatSplitCue({
        split: 3,
        elapsedTime: 312,
        cumulativeDistance: 3000,
      }, { unit: 'kg' })

      expect(cue).toBe('Split 3. 5 minutes 12 seconds per kilometer. Total distance 3 kilometers.')
    })

    it('announces imperial split completion with miles and min/mi', () => {
      const cue = formatSplitCue({
        split: 3,
        elapsedTime: 312,
        cumulativeDistance: 4828.032,
      }, { unit: 'lbs' })

      expect(cue).toBe('Split 3. 5 minutes 12 seconds per mile. Total distance 3 miles.')
    })

    it('handles singular units for 1st split (1 minute 1 second, 1 kilometer / 1 mile)', () => {
      const metricCue = formatSplitCue({
        split: 1,
        elapsedTime: 61,
        cumulativeDistance: 1000,
      }, { unit: 'kg' })
      expect(metricCue).toBe('Split 1. 1 minute 1 second per kilometer. Total distance 1 kilometer.')

      const imperialCue = formatSplitCue({
        split: 1,
        elapsedTime: 61,
        cumulativeDistance: 1609.344,
      }, { unit: 'lbs' })
      expect(imperialCue).toBe('Split 1. 1 minute 1 second per mile. Total distance 1 mile.')
    })

    it('accepts split index and explicit options', () => {
      const cue = formatSplitCue(2, {
        paceSeconds: 330,
        totalDistance: 2,
        unit: 'kg',
      })
      expect(cue).toBe('Split 2. 5 minutes 30 seconds per kilometer. Total distance 2 kilometers.')
    })

    it('accepts split objects with pace in decimal minutes', () => {
      const cue = formatSplitCue({
        split: 4,
        pace: 5.2,
        totalDistance: 4,
        unit: 'kg',
      })
      expect(cue).toBe('Split 4. 5 minutes 12 seconds per kilometer. Total distance 4 kilometers.')
    })
  })

  describe('speakSplitCue and audio ducking', () => {
    it('calls adapter speak with { duck: true } and enables audio ducking', async () => {
      const split = {
        split: 3,
        elapsedTime: 312,
        cumulativeDistance: 3000,
      }

      const res = await speakSplitCue(split, { unit: 'kg', adapter: memoryAdapter })

      expect(res.spoken).toBe(true)
      expect(res.text).toBe('Split 3. 5 minutes 12 seconds per kilometer. Total distance 3 kilometers.')

      // Verifies adapter state and ducking
      expect(memoryAdapter.spokenCues).toHaveLength(1)
      const spoken = memoryAdapter.spokenCues[0]
      expect(spoken.text).toBe('Split 3. 5 minutes 12 seconds per kilometer. Total distance 3 kilometers.')
      expect(spoken.duck).toBe(true)
      expect(spoken.ducking).toBe(true)
      expect(memoryAdapter.isSpeaking).toBe(true)
      expect(memoryAdapter.isDucking).toBe(true)
    })

    it('passes custom speak mock with exact { duck: true } arguments', async () => {
      const customSpeak = vi.fn().mockResolvedValue({ id: 'cue-1' })
      const split = {
        split: 2,
        elapsedTime: 300,
        cumulativeDistance: 2000,
      }

      const res = await speakSplitCue(split, {
        unit: 'kg',
        speak: customSpeak,
      })

      expect(res.spoken).toBe(true)
      expect(customSpeak).toHaveBeenCalledTimes(1)
      expect(customSpeak).toHaveBeenCalledWith(
        'Split 2. 5 minutes per kilometer. Total distance 2 kilometers.',
        { duck: true }
      )
    })

    it('suppresses speech cues when S.voiceCues is false', async () => {
      const customSpeak = vi.fn()
      const split = {
        split: 1,
        elapsedTime: 300,
        cumulativeDistance: 1000,
      }

      // Disabled via S object
      const res1 = await speakSplitCue(split, {
        S: { voiceCues: false },
        speak: customSpeak,
      })
      expect(res1.spoken).toBe(false)
      expect(res1.reason).toBe('disabled')
      expect(customSpeak).not.toHaveBeenCalled()

      // Disabled via settings object
      const res2 = await speakSplitCue(split, {
        settings: { voiceCues: false },
        speak: customSpeak,
      })
      expect(res2.spoken).toBe(false)
      expect(res2.reason).toBe('disabled')
      expect(customSpeak).not.toHaveBeenCalled()

      // Disabled via direct voiceCues option
      const res3 = await speakSplitCue(split, {
        voiceCues: false,
        speak: customSpeak,
      })
      expect(res3.spoken).toBe(false)
      expect(res3.reason).toBe('disabled')
      expect(customSpeak).not.toHaveBeenCalled()

      // Also nothing recorded in memoryAdapter
      expect(memoryAdapter.spokenCues).toHaveLength(0)
    })

    it('speaks cue when S.voiceCues is true', async () => {
      const customSpeak = vi.fn().mockResolvedValue({ id: 'cue-ok' })
      const split = {
        split: 1,
        elapsedTime: 300,
        cumulativeDistance: 1000,
      }

      const res = await speakSplitCue(split, {
        S: { voiceCues: true, unit: 'kg' },
        speak: customSpeak,
      })
      expect(res.spoken).toBe(true)
      expect(customSpeak).toHaveBeenCalledWith(
        'Split 1. 5 minutes per kilometer. Total distance 1 kilometer.',
        { duck: true }
      )
    })

    it('announceSplit is an alias for speakSplitCue', async () => {
      expect(announceSplit).toBe(speakSplitCue)
    })
  })

  describe('Integration with useStore user settings', () => {
    it('respects store S.voiceCues toggle state and unit profile', async () => {
      const store = useStore.getState()

      // Turn off voiceCues in store
      store.update(s => {
        s.voiceCues = false
      })

      const resDisabled = await speakSplitCue({
        split: 1,
        elapsedTime: 300,
        cumulativeDistance: 1000,
      }, { adapter: memoryAdapter })

      expect(resDisabled.spoken).toBe(false)
      expect(memoryAdapter.spokenCues).toHaveLength(0)

      // Turn voiceCues back on with imperial unit
      store.update(s => {
        s.voiceCues = true
        s.unit = 'lbs'
      })

      const resEnabled = await speakSplitCue({
        split: 1,
        elapsedTime: 480,
        cumulativeDistance: 1609.344,
      }, { adapter: memoryAdapter })

      expect(resEnabled.spoken).toBe(true)
      expect(resEnabled.text).toBe('Split 1. 8 minutes per mile. Total distance 1 mile.')
      expect(memoryAdapter.spokenCues).toHaveLength(1)
      expect(memoryAdapter.spokenCues[0].duck).toBe(true)
    })
  })
})
