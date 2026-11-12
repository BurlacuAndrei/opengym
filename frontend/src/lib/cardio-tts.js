import { speak as defaultSpeak } from './speech.js'
import { METERS_PER_KM, METERS_PER_MILE, isImperial as isFormatImperial } from './cardio-format.js'
import { useStore } from '../store/useStore.js'

/**
 * Checks whether voice split cues are enabled.
 * Defaults to true if setting is unset or undefined.
 *
 * @param {Object|boolean} [settings] - Settings object, store state S, or boolean flag
 * @returns {boolean}
 */
export function isVoiceCuesEnabled(settings) {
  if (typeof settings === 'boolean') {
    return settings
  }

  if (settings && typeof settings === 'object') {
    if (settings.voiceCues !== undefined) {
      return Boolean(settings.voiceCues)
    }
  }

  try {
    const storeS = useStore?.getState?.()?.S
    if (storeS && storeS.voiceCues !== undefined) {
      return Boolean(storeS.voiceCues)
    }
  } catch (e) {
    /* ignore store access error in isolated test environments */
  }

  return true
}

/**
 * Determines whether the given unit string represents imperial units.
 *
 * @param {string} [unit='kg']
 * @returns {boolean}
 */
export function isImperialUnit(unit) {
  if (!unit) return false
  return unit === 'lbs' || unit === 'mi' || unit === 'imperial' || isFormatImperial(unit)
}

/**
 * Formats a duration in seconds into spoken English words.
 * e.g. 312 -> "5 minutes 12 seconds"
 *      60 -> "1 minute"
 *      120 -> "2 minutes"
 *      1 -> "1 second"
 *      45 -> "45 seconds"
 *
 * @param {number} totalSeconds
 * @param {Object} [options={}]
 * @param {boolean} [options.includeZeroSeconds=false]
 * @returns {string}
 */
export function formatDurationSpoken(totalSeconds, options = {}) {
  const rounded = Math.round(Number(totalSeconds) || 0)
  const mins = Math.floor(rounded / 60)
  const secs = rounded % 60

  const parts = []
  if (mins > 0) {
    parts.push(`${mins} ${mins === 1 ? 'minute' : 'minutes'}`)
  }
  if (secs > 0 || (mins === 0 && !options.includeZeroSeconds)) {
    parts.push(`${secs} ${secs === 1 ? 'second' : 'seconds'}`)
  } else if (options.includeZeroSeconds && secs === 0) {
    parts.push('0 seconds')
  }

  return parts.join(' ') || '0 seconds'
}

/**
 * Formats a distance into spoken English words with proper singular/plural units.
 * Supports meters (>100) or already-converted unit values (<=100).
 *
 * @param {number} distanceMetersOrUnits
 * @param {string} [unit='kg']
 * @returns {string}
 */
export function formatDistanceSpoken(distanceMetersOrUnits, unit = 'kg') {
  const imperial = isImperialUnit(unit)
  const unitSingular = imperial ? 'mile' : 'kilometer'
  const unitPlural = imperial ? 'miles' : 'kilometers'

  let distVal = Number(distanceMetersOrUnits) || 0
  if (distVal > 100) {
    distVal = imperial ? distVal / METERS_PER_MILE : distVal / METERS_PER_KM
  }

  const rounded = Math.round(distVal * 100) / 100
  const unitWord = rounded === 1 ? unitSingular : unitPlural
  return `${rounded} ${unitWord}`
}

/**
 * Formats pace into spoken words:
 * e.g. "5 minutes 12 seconds per kilometer"
 *
 * @param {number} pace - Pace in seconds (or minutes if options.inMinutes or pace < 35)
 * @param {string} [unit='kg']
 * @param {Object} [options={}]
 * @returns {string}
 */
export function formatPaceSpoken(pace, unit = 'kg', options = {}) {
  const imperial = isImperialUnit(unit)
  const paceUnitWord = imperial ? 'mile' : 'kilometer'

  let seconds = Number(pace) || 0
  if (options.inMinutes || (seconds > 0 && seconds < 35 && !options.inSeconds)) {
    seconds = seconds * 60
  }

  const durationStr = formatDurationSpoken(seconds, options)
  return `${durationStr} per ${paceUnitWord}`
}

/**
 * Formats a split cue into the spoken announcement string.
 * Example:
 * "Split 3. 5 minutes 12 seconds per kilometer. Total distance 3 kilometers."
 *
 * @param {Object|number} split - Split object from computeSplits or split index number
 * @param {Object} [options={}] - Options (pace, elapsedTime, cumulativeDistance, unit, S, settings)
 * @returns {string}
 */
export function formatSplitCue(split, options = {}) {
  let splitIndex = 1
  let paceSeconds = null
  let totalDistance = null
  let unit = options.unit || options.S?.unit || options.settings?.unit

  if (typeof split === 'number') {
    splitIndex = split
  } else if (split && typeof split === 'object') {
    splitIndex = split.split ?? split.index ?? 1
    if (split.unit && !unit) {
      unit = split.unit
    }

    if (split.paceSeconds != null) {
      paceSeconds = split.paceSeconds
    } else if (split.elapsedTime != null) {
      paceSeconds = split.elapsedTime
    } else if (split.pace != null) {
      paceSeconds = split.pace < 35 ? split.pace * 60 : split.pace
    } else if (split.movingTime != null) {
      paceSeconds = split.movingTime
    }

    if (split.cumulativeDistance != null) {
      totalDistance = split.cumulativeDistance
    } else if (split.totalDistance != null) {
      totalDistance = split.totalDistance
    } else if (split.distance != null) {
      totalDistance = split.distance * splitIndex
    }
  }

  if (options.splitIndex != null) splitIndex = options.splitIndex
  if (options.paceSeconds != null) paceSeconds = options.paceSeconds
  else if (options.elapsedTime != null) paceSeconds = options.elapsedTime
  else if (options.pace != null) paceSeconds = options.pace < 35 ? options.pace * 60 : options.pace

  if (options.totalDistance != null) totalDistance = options.totalDistance
  else if (options.cumulativeDistance != null) totalDistance = options.cumulativeDistance
  else if (options.totalDistanceMeters != null) totalDistance = options.totalDistanceMeters

  if (!unit) {
    try {
      const storeUnit = useStore?.getState?.()?.S?.unit
      if (storeUnit) unit = storeUnit
    } catch (e) {
      /* ignore */
    }
  }

  if (!unit) unit = 'kg'

  if (totalDistance == null) {
    totalDistance = splitIndex
  }

  const paceSpoken = formatPaceSpoken(paceSeconds ?? 0, unit, { inSeconds: true })
  const distSpoken = formatDistanceSpoken(totalDistance, unit)

  return `Split ${splitIndex}. ${paceSpoken}. Total distance ${distSpoken}.`
}

/**
 * Speaks an arbitrary cardio voice cue via device adapter TTS with ducking enabled.
 * If voice cues are disabled in settings/store, suppresses speech.
 *
 * @param {string} text - Spoken message
 * @param {Object} [options={}] - Options (adapter, speak, S, settings, voiceCues)
 * @returns {Promise<{ spoken: boolean, text?: string, reason?: string, cue?: any }>}
 */
export async function speakCardioCue(text, options = {}) {
  const settingSource =
    options.voiceCues !== undefined
      ? options.voiceCues
      : (options.S ?? options.settings)

  const enabled = isVoiceCuesEnabled(settingSource)
  if (!enabled) {
    return { spoken: false, reason: 'disabled' }
  }

  const adapter = options.adapter
  const speakFn = options.speak || (adapter ? (t, o) => adapter.speak(t, o) : defaultSpeak)

  const cue = await speakFn(text, { duck: true })
  return { spoken: true, text, cue }
}

/**
 * Speaks a split cue via cardio device adapter TTS with ducking enabled.
 * If voice cues are disabled in settings/store, suppresses speech.
 *
 * @param {Object|number} split - Split data
 * @param {Object} [options={}] - Options (adapter, speak, S, settings, voiceCues, unit)
 * @returns {Promise<{ spoken: boolean, text?: string, reason?: string, cue?: any }>}
 */
export async function speakSplitCue(split, options = {}) {
  const settingSource =
    options.voiceCues !== undefined
      ? options.voiceCues
      : (options.S ?? options.settings)

  const enabled = isVoiceCuesEnabled(settingSource)
  if (!enabled) {
    return { spoken: false, reason: 'disabled' }
  }

  const text = formatSplitCue(split, options)
  return speakCardioCue(text, options)
}

export const announceSplit = speakSplitCue
