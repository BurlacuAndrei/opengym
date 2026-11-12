import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  IntervalRunner,
  createIntervalRunner,
  getStepTarget,
  getStepKind,
  getStepLabel,
  getStepCueText,
} from './interval-runner.js'
import {
  createIntervalStep,
  createRepeatStep,
  flattenIntervalSteps,
} from './interval-editor.js'
import {
  createMemoryCardioAdapter,
  setCardioAdapter,
} from './cardio-adapter.js'
import RecordingView from '../views/RecordingView.jsx'
import { RECORDING_STATUS } from './cardio-recording.js'

describe('IntervalRunner & TTS Announcer (Issue #76)', () => {
  let memoryAdapter

  beforeEach(() => {
    setCardioAdapter(null)
    memoryAdapter = createMemoryCardioAdapter()
    setCardioAdapter(memoryAdapter)
    vi.clearAllMocks()
  })

  describe('Step parsing and helpers', () => {
    it('normalizes duration-based steps with durSec, durationSec, or durationMs', () => {
      const s1 = getStepTarget({ durSec: 60 })
      expect(s1.isDuration).toBe(true)
      expect(s1.durSec).toBe(60)
      expect(s1.targetValue).toBe(60)

      const s2 = getStepTarget({ durationSec: 90 })
      expect(s2.isDuration).toBe(true)
      expect(s2.durSec).toBe(90)
      expect(s2.targetValue).toBe(90)

      const s3 = getStepTarget({ durationMs: 120000 })
      expect(s3.isDuration).toBe(true)
      expect(s3.durSec).toBe(120)
      expect(s3.targetValue).toBe(120)
    })

    it('normalizes distance-based steps with distM or distanceM', () => {
      const s1 = getStepTarget({ distM: 400 })
      expect(s1.isDistance).toBe(true)
      expect(s1.distM).toBe(400)
      expect(s1.targetValue).toBe(400)

      const s2 = getStepTarget({ distanceM: 1000 })
      expect(s2.isDistance).toBe(true)
      expect(s2.distM).toBe(1000)
      expect(s2.targetValue).toBe(1000)
    })

    it('identifies step kind and labels correctly', () => {
      expect(getStepKind({ type: 'work' })).toBe('work')
      expect(getStepKind({ type: 'recover' })).toBe('recover')
      expect(getStepKind({ kind: 'custom' })).toBe('custom')

      const queue = [
        { type: 'warmup' },
        { type: 'work' },
        { type: 'recover' },
        { type: 'work' },
      ]
      expect(getStepLabel(queue[0], 0, queue)).toBe('Warmup')
      expect(getStepLabel(queue[1], 1, queue)).toBe('Interval 1 of 2')
      expect(getStepLabel(queue[2], 2, queue)).toBe('Recovery')
      expect(getStepLabel(queue[3], 3, queue)).toBe('Interval 2 of 2')
    })

    it('formats TTS spoken cues according to spec', () => {
      const workStep = { type: 'work', distM: 400 }
      expect(getStepCueText(workStep, 0, [workStep])).toBe('Interval 1 of 1: 400 meters. Go!')

      const recStep = { type: 'recover', durSec: 60 }
      expect(getStepCueText(recStep, 1, [workStep, recStep])).toBe('Recovery: 1 minute.')

      const warmupStep = { type: 'warmup', durSec: 300 }
      expect(getStepCueText(warmupStep, 0, [warmupStep])).toBe('Warmup: 5 minutes.')

      const cooldownStep = { type: 'cooldown', durSec: 300 }
      expect(getStepCueText(cooldownStep, 0, [cooldownStep])).toBe('Cooldown: 5 minutes.')
    })
  })

  describe('Time-based steps execution', () => {
    it('advances on reaching duration target and records split', async () => {
      const onSplit = vi.fn()
      const runner = createIntervalRunner({
        steps: [
          { type: 'work', durSec: 60 },
          { type: 'recover', durSec: 30 },
        ],
        adapter: memoryAdapter,
        onSplit,
      })

      expect(runner.status).toBe('idle')
      await runner.start({ distanceM: 0, durationSec: 0 })
      expect(runner.status).toBe('running')
      expect(runner.currentIndex).toBe(0)
      expect(runner.currentStep.type).toBe('work')

      // Announce first step cue
      expect(memoryAdapter.spokenCues).toHaveLength(1)
      expect(memoryAdapter.spokenCues[0].text).toBe('Interval 1 of 1: 1 minute. Go!')

      // Halfway: no transition
      await runner.update({ distanceM: 100, durationSec: 30 })
      expect(runner.currentIndex).toBe(0)
      expect(runner.splits).toHaveLength(0)

      // Duration reached (60s)
      await runner.update({ distanceM: 200, durationSec: 60 })
      expect(runner.currentIndex).toBe(1)
      expect(runner.splits).toHaveLength(1)
      expect(onSplit).toHaveBeenCalledTimes(1)

      const split = runner.splits[0]
      expect(split).toEqual({
        stepIndex: 0,
        label: 'Interval 1 of 1',
        kind: 'work',
        targetValue: 60,
        actualDistanceM: 200,
        actualDurationSec: 60,
      })

      // Next step cue spoken: Recovery
      expect(memoryAdapter.spokenCues).toHaveLength(2)
      expect(memoryAdapter.spokenCues[1].text).toBe('Recovery: 30 seconds.')

      // Recover step complete at 90s total (30s step duration)
      await runner.update({ distanceM: 250, durationSec: 90 })
      expect(runner.currentIndex).toBe(2)
      expect(runner.splits).toHaveLength(2)
      expect(runner.splits[1]).toEqual({
        stepIndex: 1,
        label: 'Recovery',
        kind: 'recover',
        targetValue: 30,
        actualDistanceM: 50,
        actualDurationSec: 30,
      })

      // All steps complete: status is cooldown, workout complete announced
      expect(runner.status).toBe('cooldown')
      expect(runner.isComplete).toBe(true)
      expect(memoryAdapter.spokenCues).toHaveLength(3)
      expect(memoryAdapter.spokenCues[2].text).toBe('Workout complete.')

      // Further updates while in cooldown continue recording without extra interval transitions
      await runner.update({ distanceM: 500, durationSec: 150 })
      expect(runner.splits).toHaveLength(2)
      expect(runner.status).toBe('cooldown')
    })
  })

  describe('Distance-based steps execution', () => {
    it('advances on reaching distance target (distM)', async () => {
      const runner = createIntervalRunner({
        steps: [
          { type: 'work', distM: 400 },
          { type: 'recover', distM: 200 },
        ],
        adapter: memoryAdapter,
      })

      await runner.start({ distanceM: 100, durationSec: 10 })
      expect(runner.currentIndex).toBe(0)
      expect(memoryAdapter.spokenCues[0].text).toBe('Interval 1 of 1: 400 meters. Go!')

      // At 300m total (200m in step): not finished yet
      await runner.update({ distanceM: 300, durationSec: 60 })
      expect(runner.currentIndex).toBe(0)

      // At 500m total (400m in step): work step complete
      await runner.update({ distanceM: 500, durationSec: 120 })
      expect(runner.currentIndex).toBe(1)
      expect(runner.splits).toHaveLength(1)
      expect(runner.splits[0]).toEqual({
        stepIndex: 0,
        label: 'Interval 1 of 1',
        kind: 'work',
        targetValue: 400,
        actualDistanceM: 400,
        actualDurationSec: 110,
      })

      expect(memoryAdapter.spokenCues[1].text).toBe('Recovery: 200 meters.')

      // At 700m total (200m in recover step): recover complete
      await runner.update({ distanceM: 700, durationSec: 200 })
      expect(runner.splits).toHaveLength(2)
      expect(runner.splits[1]).toEqual({
        stepIndex: 1,
        label: 'Recovery',
        kind: 'recover',
        targetValue: 200,
        actualDistanceM: 200,
        actualDurationSec: 80,
      })

      expect(runner.status).toBe('cooldown')
      expect(memoryAdapter.spokenCues[2].text).toBe('Workout complete.')
    })
  })

  describe('Repeat blocks and flattening', () => {
    it('flattens repeat block into active queue with iteration metadata', () => {
      const repeat = createRepeatStep(3, { distanceM: 400 }, { durationMs: 60000 })
      const steps = [
        createIntervalStep('warmup', { durationMs: 300000 }),
        repeat,
        createIntervalStep('cooldown', { durationMs: 300000 }),
      ]

      const flat = flattenIntervalSteps(steps)
      // 1 warmup + 3*(work + recover) + 1 cooldown = 8 steps
      expect(flat).toHaveLength(8)
      expect(flat[0].type).toBe('warmup')
      expect(flat[1].type).toBe('work')
      expect(flat[1].repeatIndex).toBe(1)
      expect(flat[1].repeatCount).toBe(3)
      expect(flat[2].type).toBe('recover')
      expect(flat[2].repeatIndex).toBe(1)
      expect(flat[3].type).toBe('work')
      expect(flat[3].repeatIndex).toBe(2)
      expect(flat[4].type).toBe('recover')
      expect(flat[5].type).toBe('work')
      expect(flat[5].repeatIndex).toBe(3)
      expect(flat[6].type).toBe('recover')
      expect(flat[7].type).toBe('cooldown')
    })

    it('executes repeat block with interval numbering X of Y cues', async () => {
      const repeat = createRepeatStep(2, { distM: 200 }, { durSec: 30 })
      const runner = new IntervalRunner({
        steps: [repeat],
        adapter: memoryAdapter,
      })

      await runner.start({ distanceM: 0, durationSec: 0 })

      // First work step announcement: "Interval 1 of 2: 200 meters. Go!"
      expect(memoryAdapter.spokenCues[0].text).toBe('Interval 1 of 2: 200 meters. Go!')

      // Complete work 1
      await runner.update({ distanceM: 200, durationSec: 40 })
      expect(runner.splits[0].label).toBe('Interval 1 of 2')
      expect(memoryAdapter.spokenCues[1].text).toBe('Recovery: 30 seconds.')

      // Complete recovery 1
      await runner.update({ distanceM: 220, durationSec: 70 })
      expect(runner.splits[1].label).toBe('Recovery')
      expect(memoryAdapter.spokenCues[2].text).toBe('Interval 2 of 2: 200 meters. Go!')

      // Complete work 2
      await runner.update({ distanceM: 420, durationSec: 110 })
      expect(runner.splits[2].label).toBe('Interval 2 of 2')
      expect(memoryAdapter.spokenCues[3].text).toBe('Recovery: 30 seconds.')

      // Complete recovery 2
      await runner.update({ distanceM: 450, durationSec: 140 })
      expect(runner.splits[3].label).toBe('Recovery')
      expect(runner.status).toBe('cooldown')
      expect(memoryAdapter.spokenCues[4].text).toBe('Workout complete.')
      expect(runner.splits).toHaveLength(4)
    })
  })

  describe('TTS voice cues suppression and controls', () => {
    it('suppresses speech when voiceCues is false', async () => {
      const runner = createIntervalRunner({
        steps: [
          { type: 'work', durSec: 30 },
          { type: 'recover', durSec: 30 },
        ],
        voiceCues: false,
        adapter: memoryAdapter,
      })

      await runner.start()
      expect(memoryAdapter.spokenCues).toHaveLength(0)

      await runner.update({ distanceM: 100, durationSec: 30 })
      expect(memoryAdapter.spokenCues).toHaveLength(0)
      expect(runner.splits).toHaveLength(1)
    })

    it('allows manual skipping via nextStep', async () => {
      const runner = createIntervalRunner({
        steps: [
          { type: 'work', durSec: 120 },
          { type: 'recover', durSec: 60 },
        ],
        adapter: memoryAdapter,
      })

      await runner.start({ distanceM: 0, durationSec: 0 })
      expect(runner.currentIndex).toBe(0)

      // Skip step at 45s (before target of 120s)
      await runner.nextStep({ distanceM: 150, durationSec: 45 })
      expect(runner.currentIndex).toBe(1)
      expect(runner.splits).toHaveLength(1)
      expect(runner.splits[0].actualDurationSec).toBe(45)
      expect(runner.splits[0].actualDistanceM).toBe(150)
      expect(memoryAdapter.spokenCues[1].text).toBe('Recovery: 1 minute.')
    })
  })

  describe('RecordingView integration', () => {
    function createMockRecorder() {
      const state = {
        status: RECORDING_STATUS.RECORDING,
        id: 'rec-test-interval',
        activityType: 'run',
        startTime: '2026-11-12T08:00:00.000Z',
        isRecording: true,
        pointsCount: 1,
        accuracy: 5,
        liveStats: {
          distanceM: 200,
          movingTimeMs: 60000,
          elapsedTimeMs: 60000,
          avgPace: 5.0,
          avgSpeed: 3.33,
          elevationGainM: 10,
          calories: 15,
        },
      }
      return {
        state,
        points: [{ lat: 52.5, lon: 13.4, accuracy: 5 }],
        getState: vi.fn(() => ({ ...state })),
        getLiveStats: vi.fn(() => ({ ...state.liveStats })),
        subscribe: vi.fn(() => () => {}),
        startRecording: vi.fn(),
        pauseRecording: vi.fn(),
        resumeRecording: vi.fn(),
        finishRecording: vi.fn(async opts => ({ ...state, ...opts })),
        discardRecording: vi.fn(),
      }
    }

    it('renders interval runner banner in RecordingView live screen', () => {
      const runner = createIntervalRunner({
        steps: [
          { type: 'work', distM: 400 },
          { type: 'recover', durSec: 60 },
        ],
        adapter: memoryAdapter,
      })

      const html = renderToStaticMarkup(
        React.createElement(RecordingView, {
          recorder: createMockRecorder(),
          intervalRunner: runner,
        })
      )

      expect(html).toContain('data-testid="interval-runner-banner"')
      expect(html).toContain('data-testid="interval-runner-status"')
      expect(html).toContain('Interval Mode')
      expect(html).toContain('data-testid="interval-current-step-label"')
      expect(html).toContain('Interval 1 of 1')
      expect(html).toContain('400 meters')
    })
  })
})
