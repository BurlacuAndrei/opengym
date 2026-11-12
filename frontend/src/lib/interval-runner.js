import { flattenIntervalSteps } from './interval-editor.js'
import {
  speakCardioCue,
  formatDurationSpoken,
  formatDistanceSpoken,
  isImperialUnit,
} from './cardio-tts.js'

/**
 * Extracts and normalizes target distance and duration from an interval step.
 * Supports distM/distanceM and durSec/durationSec/durationMs.
 *
 * @param {Object} step
 * @returns {{ distM: number|null, durSec: number|null, isDistance: boolean, isDuration: boolean, targetType: string, targetValue: number }}
 */
export function getStepTarget(step) {
  if (!step || typeof step !== 'object') {
    return {
      distM: null,
      durSec: null,
      isDistance: false,
      isDuration: false,
      targetType: 'duration',
      targetValue: 0,
    }
  }

  let distM = null
  if (step.distM != null && !isNaN(Number(step.distM))) {
    distM = Number(step.distM)
  } else if (step.distanceM != null && !isNaN(Number(step.distanceM))) {
    distM = Number(step.distanceM)
  } else if (step.targetDistanceM != null && !isNaN(Number(step.targetDistanceM))) {
    distM = Number(step.targetDistanceM)
  }

  let durSec = null
  if (step.durSec != null && !isNaN(Number(step.durSec))) {
    durSec = Number(step.durSec)
  } else if (step.durationSec != null && !isNaN(Number(step.durationSec))) {
    durSec = Number(step.durationSec)
  } else if (step.durationMs != null && !isNaN(Number(step.durationMs))) {
    durSec = Number(step.durationMs) / 1000
  }

  const hasDist = distM != null && distM > 0
  const hasDur = durSec != null && durSec > 0
  const hasExplicitDist =
    (step.distM != null && !isNaN(Number(step.distM))) ||
    (step.distanceM != null && !isNaN(Number(step.distanceM)))
  const hasExplicitDur =
    (step.durSec != null && !isNaN(Number(step.durSec))) ||
    (step.durationSec != null && !isNaN(Number(step.durationSec)))

  let isDistance = false
  let isDuration = false

  if (step.targetType === 'distance' && hasDist) {
    isDistance = true
  } else if (step.targetType === 'duration' && hasDur) {
    isDuration = true
  } else if (hasExplicitDist && !hasExplicitDur) {
    isDistance = true
  } else if (hasExplicitDur && !hasExplicitDist) {
    isDuration = true
  } else if (hasDist && !hasDur) {
    isDistance = true
  } else if (hasDur && !hasDist) {
    isDuration = true
  } else if (hasDist && hasDur) {
    if (step.distM != null) {
      isDistance = true
    } else {
      isDuration = true
    }
  }

  const targetType = isDistance ? 'distance' : 'duration'
  const targetValue = isDistance ? (distM || 0) : (durSec || 0)

  return {
    distM,
    durSec,
    isDistance,
    isDuration,
    targetType,
    targetValue,
  }
}

/**
 * Returns the logical kind of the step (e.g. work, recover, warmup, cooldown).
 *
 * @param {Object} step
 * @returns {string}
 */
export function getStepKind(step) {
  if (!step || typeof step !== 'object') return 'work'
  if (step.kind) return step.kind
  if (step.type) return step.type
  const target = getStepTarget(step)
  return target.isDistance ? 'distance' : 'duration'
}

/**
 * Computes a human-readable step label (e.g. "Interval 1 of 4", "Recovery", "Warmup").
 *
 * @param {Object} step
 * @param {number} [stepIndex=0]
 * @param {Array} [queue=[]]
 * @returns {string}
 */
export function getStepLabel(step, stepIndex = 0, queue = []) {
  if (!step) return ''
  if (step.label) return step.label

  const kind = getStepKind(step)

  if (kind === 'work') {
    if (step.repeatIndex && step.repeatCount) {
      return `Interval ${step.repeatIndex} of ${step.repeatCount}`
    }

    const workSteps = queue.filter(s => getStepKind(s) === 'work')
    const totalWork = workSteps.length
    if (totalWork > 1) {
      let workIdx = 0
      for (let i = 0; i <= stepIndex && i < queue.length; i++) {
        if (getStepKind(queue[i]) === 'work') workIdx++
      }
      return `Interval ${workIdx || 1} of ${totalWork}`
    }
    return totalWork === 1 ? 'Interval 1 of 1' : 'Interval'
  }

  if (kind === 'recover' || kind === 'recovery') {
    return 'Recovery'
  }

  if (kind === 'warmup') {
    return 'Warmup'
  }

  if (kind === 'cooldown') {
    return 'Cooldown'
  }

  return step.name || `Step ${stepIndex + 1}`
}

/**
 * Generates natural spoken cue text for a step.
 * e.g. "Interval 1 of 4: 400 meters. Go!", "Recovery: 1 minute.", "Warmup: 5 minutes."
 *
 * @param {Object} step
 * @param {number} [stepIndex=0]
 * @param {Array} [queue=[]]
 * @param {string} [unit='kg']
 * @returns {string}
 */
export function getStepCueText(step, stepIndex = 0, queue = [], unit = 'kg') {
  if (!step) return ''
  if (step.cue) return step.cue

  const label = getStepLabel(step, stepIndex, queue)
  const kind = getStepKind(step)
  const target = getStepTarget(step)

  let targetSpoken = ''
  if (target.isDistance) {
    const dist = target.distM || 0
    if (dist < 1000 && !isImperialUnit(unit)) {
      targetSpoken = `${dist} meters`
    } else {
      targetSpoken = formatDistanceSpoken(dist, unit)
    }
  } else if (target.isDuration) {
    targetSpoken = formatDurationSpoken(target.durSec || 0)
  }

  if (kind === 'work') {
    return targetSpoken ? `${label}: ${targetSpoken}. Go!` : `${label}: Go!`
  }

  if (kind === 'recover' || kind === 'recovery') {
    return targetSpoken ? `Recovery: ${targetSpoken}.` : 'Recovery.'
  }

  if (kind === 'warmup') {
    return targetSpoken ? `Warmup: ${targetSpoken}.` : 'Warmup.'
  }

  if (kind === 'cooldown') {
    return targetSpoken ? `Cooldown: ${targetSpoken}.` : 'Cooldown.'
  }

  return targetSpoken ? `${label}: ${targetSpoken}.` : `${label}.`
}

/**
 * Live structured interval state machine and step announcer during GPS recording (Issue #76).
 */
export class IntervalRunner {
  constructor(options = {}) {
    const rawSteps = options.steps || []
    this.queue = flattenIntervalSteps(rawSteps)
    this.currentIndex = 0
    this.status = this.queue.length > 0 ? 'idle' : 'cooldown'
    this.splits = []

    this.ttsOptions = {
      adapter: options.adapter,
      speak: options.speak,
      voiceCues: options.voiceCues,
      settings: options.settings,
      S: options.S,
    }
    this.unit = options.unit || 'kg'
    this.onSplit = options.onSplit || null
    this.onStepChange = options.onStepChange || null
    this.onComplete = options.onComplete || null

    this.stepStartDistanceM = 0
    this.stepStartDurationSec = 0
    this.currentActualDistanceM = 0
    this.currentActualDurationSec = 0
    this.totalDistanceM = 0
    this.totalDurationSec = 0
  }

  get currentStep() {
    if (this.currentIndex >= 0 && this.currentIndex < this.queue.length) {
      return this.queue[this.currentIndex]
    }
    return null
  }

  get isComplete() {
    return this.status === 'cooldown' || this.currentIndex >= this.queue.length
  }

  getStepLabel(step = this.currentStep, index = this.currentIndex) {
    return getStepLabel(step, index, this.queue)
  }

  getStepCue(step = this.currentStep, index = this.currentIndex) {
    return getStepCueText(step, index, this.queue, this.unit)
  }

  /**
   * Starts the interval runner and announces the first step.
   *
   * @param {Object} [initialStats={}]
   */
  async start(initialStats = {}) {
    if (this.status === 'running') return
    this.status = 'running'
    this.stepStartDistanceM = Number(initialStats.distanceM) || 0
    this.stepStartDurationSec = this._extractSec(initialStats)
    this.currentActualDistanceM = 0
    this.currentActualDurationSec = 0

    if (this.currentStep) {
      const cue = getStepCueText(this.currentStep, this.currentIndex, this.queue, this.unit)
      await speakCardioCue(cue, this.ttsOptions)
      if (this.onStepChange) {
        this.onStepChange(this.currentStep, this.currentIndex)
      }
    } else {
      await this._finishWorkout()
    }
  }

  /**
   * Ingests latest live recording distance and duration stats.
   * Checks step completion criteria, records splits, and announces next step.
   *
   * @param {Object|number} arg1 - Stats object or distance in meters
   * @param {number} [arg2] - Duration in seconds if arg1 is distance
   */
  async update(arg1, arg2) {
    const { distanceM, durationSec } = this._parseStats(arg1, arg2)
    this.totalDistanceM = distanceM
    this.totalDurationSec = durationSec

    if (this.status === 'idle') {
      await this.start({ distanceM, durationSec })
      return
    }

    if (this.status !== 'running' || !this.currentStep) {
      return
    }

    const stepDist = Math.max(0, distanceM - this.stepStartDistanceM)
    const stepDur = Math.max(0, durationSec - this.stepStartDurationSec)
    this.currentActualDistanceM = stepDist
    this.currentActualDurationSec = stepDur

    const target = getStepTarget(this.currentStep)
    const distanceReached = target.isDistance && stepDist >= target.distM
    const durationReached = target.isDuration && stepDur >= target.durSec

    if (distanceReached || durationReached) {
      await this._advanceStep(stepDist, stepDur, distanceM, durationSec)
    }
  }

  /**
   * Manually skips or advances the current step.
   *
   * @param {Object} [stats={}]
   */
  async nextStep(stats = {}) {
    if (this.status !== 'running' || !this.currentStep) return
    const { distanceM, durationSec } = this._parseStats(stats)
    const currentDist = distanceM || this.totalDistanceM
    const currentDur = durationSec || this.totalDurationSec

    const stepDist = Math.max(0, currentDist - this.stepStartDistanceM)
    const stepDur = Math.max(0, currentDur - this.stepStartDurationSec)
    await this._advanceStep(stepDist, stepDur, currentDist, currentDur)
  }

  async _advanceStep(actualDistM, actualDurSec, currentTotalDistM, currentTotalDurSec) {
    const step = this.currentStep
    const stepIdx = this.currentIndex
    const target = getStepTarget(step)
    const label = getStepLabel(step, stepIdx, this.queue)
    const kind = getStepKind(step)

    const split = {
      stepIndex: stepIdx,
      label,
      kind,
      targetValue: target.targetValue,
      actualDistanceM: actualDistM,
      actualDurationSec: actualDurSec,
    }

    this.splits.push(split)
    if (this.onSplit) {
      this.onSplit(split)
    }

    this.currentIndex++
    this.stepStartDistanceM = currentTotalDistM
    this.stepStartDurationSec = currentTotalDurSec
    this.currentActualDistanceM = 0
    this.currentActualDurationSec = 0

    if (this.currentIndex < this.queue.length) {
      const nextStep = this.queue[this.currentIndex]
      const cue = getStepCueText(nextStep, this.currentIndex, this.queue, this.unit)
      await speakCardioCue(cue, this.ttsOptions)
      if (this.onStepChange) {
        this.onStepChange(nextStep, this.currentIndex)
      }
    } else {
      await this._finishWorkout()
    }
  }

  async _finishWorkout() {
    this.status = 'cooldown'
    await speakCardioCue('Workout complete.', this.ttsOptions)
    if (this.onComplete) {
      this.onComplete({ splits: this.splits })
    }
  }

  _parseStats(arg1, arg2) {
    let distanceM = 0
    let durationSec = 0
    if (typeof arg1 === 'number') {
      distanceM = arg1
      durationSec = Number(arg2) || 0
    } else if (arg1 && typeof arg1 === 'object') {
      distanceM = Number(arg1.distanceM) || 0
      durationSec = this._extractSec(arg1)
    }
    return { distanceM, durationSec }
  }

  _extractSec(stats) {
    if (!stats) return 0
    if (stats.durationSec != null) return Number(stats.durationSec) || 0
    if (stats.durSec != null) return Number(stats.durSec) || 0
    if (stats.movingTimeMs != null) return (Number(stats.movingTimeMs) || 0) / 1000
    if (stats.elapsedTimeMs != null) return (Number(stats.elapsedTimeMs) || 0) / 1000
    if (stats.durationMs != null) return (Number(stats.durationMs) || 0) / 1000
    return 0
  }
}

/**
 * Factory helper for IntervalRunner.
 *
 * @param {Object} options
 * @returns {IntervalRunner}
 */
export function createIntervalRunner(options = {}) {
  return new IntervalRunner(options)
}
