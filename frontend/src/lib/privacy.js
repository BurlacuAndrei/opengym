// Privacy and informed-consent management (Issue #39).
// Keeps timestamped consent records in profile state under S.privacy.consents.
import { t } from './i18n.js'

export const CONSENT_VERSION = 1

/**
 * Registry of external features that transmit data outside local storage.
 * Displayed in Settings -> Privacy with recipient, purpose, and revocation options.
 */
export const EXTERNAL_FEATURES = [
  {
    id: 'coach',
    name: 'AI Coach',
    recipient: 'Configured AI Provider',
    recipientUrl: '',
    triggerTiming: 'On-demand when requesting training plan generation or review',
    payloadSummary: 'Plan routines, exercise sets, logged weights, reps, RIR/RPE ratings, and bodyweight goals.',
    revocationInstructions: 'Toggle off at any time. Revoking consent halts remote requests and clears cached AI proposals.',
    icon: 'sparkles',
    tint: 'var(--acc)'
  },
  {
    id: 'server_sync',
    name: 'Server Sync',
    recipient: 'Configured openGym server instance',
    recipientUrl: '',
    triggerTiming: 'Automatic background synchronization when signed in',
    payloadSummary: 'Workout history, routines, bodyweight records, and user preferences.',
    revocationInstructions: 'Disconnect or revoke to keep all workout data strictly local on this device.',
    icon: 'cloud',
    tint: 'var(--blue)'
  },
  {
    id: 'cardio_gps',
    name: 'Cardio GPS & Location',
    recipient: 'On-device Location Provider & Track Storage',
    recipientUrl: '',
    triggerTiming: 'Active tracking during outdoor cardio sessions',
    payloadSummary: 'GPS coordinates, timestamps, pace, altitude, and total distance.',
    revocationInstructions: 'Revoking consent disables location capture. Cardio workouts record duration only.',
    icon: 'compass',
    tint: 'var(--teal)'
  },
  {
    id: 'notifications',
    name: 'Push Notifications',
    recipient: 'Platform Push Notification Gateway',
    recipientUrl: '',
    triggerTiming: 'Scheduled workout reminder intervals',
    payloadSummary: 'Push subscription endpoint, public encryption key, and auth token.',
    revocationInstructions: 'Toggle off to unsubscribe from all push notification dispatches.',
    icon: 'bell',
    tint: 'var(--orange)'
  }
]

/** Returns S.privacy or default empty consents map. */
export function getPrivacy(S) {
  return S?.privacy || { consents: {} }
}

/** Returns the consent record for a specific feature, or null if not found. */
export function getConsent(S, featureId) {
  if (!S || !featureId) return null
  return S.privacy?.consents?.[featureId] || null
}

/**
 * Checks whether consent is currently granted and active for a given feature.
 * Accepts either (S, featureId) or (featureId) delegating to useStore if available.
 */
export function hasConsent(sOrFeature, maybeFeatureId) {
  if (typeof sOrFeature === 'string') {
    try {
      const { useStore } = require_store()
      return hasConsent(useStore.getState().S, sOrFeature)
    } catch {
      return false
    }
  }
  const S = sOrFeature
  const featureId = maybeFeatureId
  if (!S || !featureId) return false

  const c = getConsent(S, featureId)
  if (c && c.agreedAt && !c.revokedAt) return true

  // Backward compatibility: check S.coach.consent if checking 'coach'
  if (featureId === 'coach' && S.coach?.consent?.agreedAt && !c?.revokedAt) {
    return true
  }

  return false
}

export const checkConsent = hasConsent

/**
 * Grants consent for a feature with a timestamp and optional metadata.
 * Mutates draft S (or initializes S.privacy) and returns the created consent record.
 */
export function grantConsent(sOrFeature, featureOrDetails, maybeDetails) {
  if (typeof sOrFeature === 'string') {
    try {
      const { useStore } = require_store()
      return useStore.getState().grantConsent(sOrFeature, featureOrDetails)
    } catch {
      return null
    }
  }

  const S = sOrFeature
  const featureId = featureOrDetails
  const details = maybeDetails || {}

  if (!S || !featureId) return null
  if (!S.privacy) S.privacy = { consents: {} }
  if (!S.privacy.consents) S.privacy.consents = {}

  const now = details.agreedAt || new Date().toISOString()
  const prev = S.privacy.consents[featureId] || {}

  const record = {
    ...prev,
    ...details,
    agreedAt: now,
    revokedAt: null,
    recipient: details.recipient || prev.recipient || '',
    version: details.version || CONSENT_VERSION
  }
  S.privacy.consents[featureId] = record

  // Keep S.coach in sync if granting 'coach'
  if (featureId === 'coach' && S.coach) {
    S.coach.consent = { agreedAt: now, version: record.version }
  }

  return record
}

/**
 * Revokes consent for a feature, setting agreedAt to null and recording revokedAt timestamp.
 */
export function revokeConsent(sOrFeature, maybeFeatureId) {
  if (typeof sOrFeature === 'string') {
    try {
      const { useStore } = require_store()
      return useStore.getState().revokeConsent(sOrFeature)
    } catch {
      return null
    }
  }

  const S = sOrFeature
  const featureId = maybeFeatureId

  if (!S || !featureId) return null
  if (!S.privacy) S.privacy = { consents: {} }
  if (!S.privacy.consents) S.privacy.consents = {}

  const prev = S.privacy.consents[featureId] || {}
  const now = new Date().toISOString()

  const record = {
    ...prev,
    agreedAt: null,
    revokedAt: now
  }
  S.privacy.consents[featureId] = record

  // Keep S.coach in sync if revoking 'coach'
  if (featureId === 'coach' && S.coach) {
    S.coach.consent = null
    S.coach.cadence = 'off'
  }

  return record
}

/** Returns all consent records map. */
export function listConsents(S) {
  return S?.privacy?.consents || {}
}

/** Helper to format ISO timestamp into localized readable date string. */
export function formatConsentDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return String(iso)
  }
}

// Store accessor reference to support single-argument calls
let _useStore = null
export function setPrivacyStore(store) {
  _useStore = store
}
function require_store() {
  if (_useStore) return { useStore: _useStore }
  return { useStore: (typeof window !== 'undefined' && window.__OPEN_GYM_STORE__) || null }
}
