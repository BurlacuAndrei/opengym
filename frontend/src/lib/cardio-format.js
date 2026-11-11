// Cardio unit formatting and calculation helpers (Issue #37).
//
// Supports metric ('kg') and imperial ('lbs') profile units:
//   - 'kg'  -> km, min/km, km/h, m elevation, 1000m split
//   - 'lbs' -> mi, min/mi, mph, ft elevation, 1609.344m split
//
// Primary rate metric per activity type:
//   - 'run', 'hike', 'walk' default to pace
//   - 'ride' defaults to speed
//
// Handles null, zero, negative, and edge cases gracefully.

import { fmtNum } from './format.js'

// Distance constants (metres)
export const METERS_PER_KM = 1000
export const METERS_PER_MILE = 1609.344
export const METERS_PER_FOOT = 0.3048
export const FEET_PER_METER = 1 / 0.3048

// Split distance constants (metres)
export const SPLIT_DIST_METRIC = 1000
export const SPLIT_DIST_IMPERIAL = 1609.344
export const SPLIT_DISTANCE_METRIC = 1000
export const SPLIT_DISTANCE_IMPERIAL = 1609.344

export const SPLIT_DISTANCE = {
  kg: SPLIT_DIST_METRIC,
  lbs: SPLIT_DIST_IMPERIAL,
}

// Unit labels and split distance by profile unit
export const CARDIO_UNITS = {
  kg: {
    dist: 'km',
    distance: 'km',
    pace: 'min/km',
    speed: 'km/h',
    elevation: 'm',
    splitDist: SPLIT_DIST_METRIC,
    splitDistance: SPLIT_DIST_METRIC,
  },
  lbs: {
    dist: 'mi',
    distance: 'mi',
    pace: 'min/mi',
    speed: 'mph',
    elevation: 'ft',
    splitDist: SPLIT_DIST_IMPERIAL,
    splitDistance: SPLIT_DIST_IMPERIAL,
  },
}

export const isImperial = unit => unit === 'lbs'
export const isMetric = unit => unit !== 'lbs'

export const cardioUnits = (unit = 'kg') => CARDIO_UNITS[isImperial(unit) ? 'lbs' : 'kg']
export const getCardioUnits = cardioUnits

export const distanceUnit = (unit = 'kg') => (isImperial(unit) ? 'mi' : 'km')
export const paceUnit = (unit = 'kg') => (isImperial(unit) ? 'min/mi' : 'min/km')
export const speedUnit = (unit = 'kg') => (isImperial(unit) ? 'mph' : 'km/h')
export const elevationUnit = (unit = 'kg') => (isImperial(unit) ? 'ft' : 'm')
export const splitDistance = (unit = 'kg') => (isImperial(unit) ? SPLIT_DIST_IMPERIAL : SPLIT_DIST_METRIC)

/**
 * Primary rate metric per activity type:
 * 'run', 'hike', 'walk' default to 'pace'; 'ride' defaults to 'speed'.
 */
export function defaultRateMetric(activityType) {
  if (!activityType) return 'pace'
  const act = String(activityType).toLowerCase().trim()
  if (act === 'ride' || act === 'bike' || act === 'cycling') return 'speed'
  if (
    act === 'run' || act === 'running' || act === 'jog' || act === 'jogging' ||
    act === 'hike' || act === 'hiking' ||
    act === 'walk' || act === 'walking'
  ) {
    return 'pace'
  }
  return 'pace'
}
export const rateMetricFor = defaultRateMetric
export const preferredRateMetric = defaultRateMetric
export const primaryRateMetric = defaultRateMetric

// Unit conversions
export const metersToKm = m => (m == null || isNaN(m) ? 0 : Number(m) / METERS_PER_KM)
export const kmToMeters = km => (km == null || isNaN(km) ? 0 : Number(km) * METERS_PER_KM)

export const metersToMiles = m => (m == null || isNaN(m) ? 0 : Number(m) / METERS_PER_MILE)
export const milesToMeters = mi => (mi == null || isNaN(mi) ? 0 : Number(mi) * METERS_PER_MILE)

export const convertDistance = (meters, unit = 'kg') =>
  isImperial(unit) ? metersToMiles(meters) : metersToKm(meters)

export const metersToFeet = m => (m == null || isNaN(m) ? 0 : Number(m) / METERS_PER_FOOT)
export const feetToMeters = ft => (ft == null || isNaN(ft) ? 0 : Number(ft) * METERS_PER_FOOT)

export const convertElevation = (meters, unit = 'kg') =>
  isImperial(unit) ? metersToFeet(meters) : (meters == null || isNaN(meters) ? 0 : Number(meters))

export const kmhToMph = kmh => (kmh == null || isNaN(kmh) ? 0 : Number(kmh) / (METERS_PER_MILE / 1000))
export const mphToKmh = mph => (mph == null || isNaN(mph) ? 0 : Number(mph) * (METERS_PER_MILE / 1000))

export const convertSpeed = (speedKmH, unit = 'kg') =>
  isImperial(unit) ? kmhToMph(speedKmH) : (speedKmH == null || isNaN(speedKmH) ? 0 : Number(speedKmH))

export const hasDist = s => Number(s && s.dist) > 0

/**
 * Pace calculation: minutes per km (metric) or minutes per mile (imperial).
 * Returns null for zero, negative, null, or invalid input.
 */
export function paceOf(min, dist, unit = 'kg') {
  const m = Number(min)
  const d = Number(dist)
  if (!m || !d || m <= 0 || d <= 0 || !isFinite(m) || !isFinite(d)) return null
  const distUnits = isImperial(unit) ? d / METERS_PER_MILE : d / METERS_PER_KM
  return distUnits > 0 ? m / distUnits : null
}

export function paceFromSeconds(sec, dist, unit = 'kg') {
  const s = Number(sec)
  if (!s || s <= 0 || !isFinite(s)) return null
  return paceOf(s / 60, dist, unit)
}

/**
 * Speed calculation: km/h (metric) or mph (imperial).
 * Returns null for zero, negative, null, or invalid input.
 */
export function speedOf(min, dist, unit = 'kg') {
  const m = Number(min)
  const d = Number(dist)
  if (!m || !d || m <= 0 || d <= 0 || !isFinite(m) || !isFinite(d)) return null
  const distUnits = isImperial(unit) ? d / METERS_PER_MILE : d / METERS_PER_KM
  const hours = m / 60
  return hours > 0 ? distUnits / hours : null
}

export function speedFromSeconds(sec, dist, unit = 'kg') {
  const s = Number(sec)
  if (!s || s <= 0 || !isFinite(s)) return null
  return speedOf(s / 60, dist, unit)
}

/**
 * Split calculation: duration in seconds for a split distance (metric 1000m, imperial 1609.344m, or custom).
 * Returns null for zero, negative, null, or invalid input.
 */
export function splitOf(min, dist, splitOrUnit = 1000) {
  const m = Number(min)
  const d = Number(dist)
  if (!m || !d || m <= 0 || d <= 0 || !isFinite(m) || !isFinite(d)) return null
  const targetDist = typeof splitOrUnit === 'number'
    ? splitOrUnit
    : splitDistance(splitOrUnit)
  return (m * 60 * targetDist) / d
}

/** Formats pace minutes into "m:ss" time string without unit. */
export function formatPaceTime(pace) {
  const p = Number(pace)
  if (!p || p <= 0 || !isFinite(p) || isNaN(p)) return ''
  const totalSeconds = Math.round(p * 60)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Formats pace with unit: "5:30 min/km" or "8:51 min/mi". */
export function formatPace(pace, unit = 'kg') {
  const timeStr = formatPaceTime(pace)
  if (!timeStr) return ''
  return `${timeStr} ${paceUnit(unit)}`
}

/**
 * fmtPace: formats pace. Short option produces "5:30 /km" instead of "5:30 min/km".
 */
export function fmtPace(pace, unit = 'kg', options = {}) {
  const timeStr = formatPaceTime(pace)
  if (!timeStr) return ''
  if (options && options.short) {
    return `${timeStr} /${distanceUnit(unit)}`
  }
  return `${timeStr} ${paceUnit(unit)}`
}

/** Formats speed with unit: "10 km/h" or "6.2 mph". */
export function formatSpeed(speed, unit = 'kg') {
  if (speed == null || speed === '' || isNaN(Number(speed))) return ''
  const s = Number(speed)
  if (s < 0 || !isFinite(s)) return ''
  return `${fmtNum(s)} ${speedUnit(unit)}`
}
export const fmtSpeed = formatSpeed

/** Formats elevation with unit: "150 m" or "492 ft". */
export function formatElevation(elevationMeters, unit = 'kg') {
  if (elevationMeters == null || elevationMeters === '' || isNaN(Number(elevationMeters))) return ''
  const m = Number(elevationMeters)
  if (!isFinite(m)) return ''
  const val = Math.round(convertElevation(m, unit))
  return `${fmtNum(val)} ${elevationUnit(unit)}`
}
export const fmtElevation = formatElevation

/** Formats distance in km or mi: "5 km" or "3.1 mi". */
export function formatDistance(meters, unit = 'kg') {
  if (meters == null || meters === '' || isNaN(Number(meters))) {
    return `0 ${distanceUnit(unit)}`
  }
  const m = Number(meters)
  if (m <= 0 || !isFinite(m)) {
    return `0 ${distanceUnit(unit)}`
  }
  const val = convertDistance(m, unit)
  return `${fmtNum(val)} ${distanceUnit(unit)}`
}

/**
 * fmtDist: compact distance representation.
 * Metric: >=1000m as km ("5 km"), <1000m as m ("800 m").
 * Imperial: in miles ("3.1 mi").
 */
export function fmtDist(meters, unit = 'kg') {
  if (meters == null || meters === '' || isNaN(Number(meters))) {
    return isImperial(unit) ? '0 mi' : '0 m'
  }
  const m = Number(meters)
  if (m <= 0 || !isFinite(m)) {
    return isImperial(unit) ? '0 mi' : '0 m'
  }
  if (isImperial(unit)) {
    return `${fmtNum(m / METERS_PER_MILE)} mi`
  }
  if (m >= 1000) {
    return `${fmtNum(m / 1000)} km`
  }
  return `${Math.round(m)} m`
}

/** Formats split duration in "m:ss" time string. */
export function formatSplitTime(seconds) {
  if (seconds == null || seconds === '' || isNaN(Number(seconds))) return ''
  const s = Number(seconds)
  if (s <= 0 || !isFinite(s)) return ''
  const total = Math.round(s)
  const min = Math.floor(total / 60)
  const sec = total % 60
  return `${min}:${String(sec).padStart(2, '0')}`
}

/**
 * High-level rate formatter: formats either pace or speed based on activity or explicit preference.
 */
export function formatRate({ min, dist, speed, activity, unit = 'kg', metric = null } = {}) {
  const effectiveMetric = metric || defaultRateMetric(activity)
  if (effectiveMetric === 'speed') {
    const spd = speed != null ? speed : speedOf(min, dist, unit)
    return formatSpeed(spd, unit)
  }
  const pace = paceOf(min, dist, unit)
  return formatPace(pace, unit)
}
