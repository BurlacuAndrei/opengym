// Per-provider jurisdiction informed-consent management for AI Coach (Issue #61).
// Maps provider presets to data destination jurisdictions (Anthropic -> US, OpenAI -> US,
// Mistral -> EU, Ollama/local -> On-Device), handles re-consent triggers on provider switch,
// and manages on-device processing bypass.

import { PROVIDER_PRESETS, PROVIDER_ALIASES, getProviderPreset } from 'shared/coach/index.js'
import { t } from './i18n.js'

export const CONSENT_VERSION = 1

export const JURISDICTIONS = Object.freeze({
  US: 'US',
  EU: 'EU',
  ON_DEVICE: 'On-Device'
})

export const JURISDICTION_LABELS = Object.freeze({
  US: 'United States',
  EU: 'European Union',
  'On-Device': 'On-Device',
  ON_DEVICE: 'On-Device'
})

/**
 * Maps provider preset IDs to destination jurisdictions.
 * Anthropic, OpenAI, Groq, OpenRouter -> US
 * Mistral -> EU
 * Ollama / local / vLLM -> On-Device
 */
export const PROVIDER_JURISDICTIONS = Object.freeze({
  anthropic: JURISDICTIONS.US,
  openai: JURISDICTIONS.US,
  groq: JURISDICTIONS.US,
  openrouter: JURISDICTIONS.US,
  mistral: JURISDICTIONS.EU,
  ollama: JURISDICTIONS.ON_DEVICE,
  local: JURISDICTIONS.ON_DEVICE,
  vllm: JURISDICTIONS.ON_DEVICE,
  claude: JURISDICTIONS.US
})

/**
 * Normalizes provider identifier string or object into canonical preset key.
 */
export function normalizeProviderId(providerOrId) {
  if (!providerOrId) return 'anthropic'
  const raw = typeof providerOrId === 'object'
    ? (providerOrId.id || providerOrId.provider || '')
    : String(providerOrId)
  const key = raw.toLowerCase().trim()
  return PROVIDER_ALIASES[key] || key || 'anthropic'
}

/**
 * Resolves the destination jurisdiction for a given provider or configuration.
 */
export function getProviderJurisdiction(providerOrId) {
  if (!providerOrId) return JURISDICTIONS.US
  if (typeof providerOrId === 'object') {
    if (providerOrId.jurisdiction) return providerOrId.jurisdiction
    if (providerOrId.local === true) return JURISDICTIONS.ON_DEVICE
  }
  const id = normalizeProviderId(providerOrId)
  if (PROVIDER_JURISDICTIONS[id]) {
    return PROVIDER_JURISDICTIONS[id]
  }
  const preset = getProviderPreset(id)
  if (preset?.local) {
    return JURISDICTIONS.ON_DEVICE
  }
  return JURISDICTIONS.US
}

/**
 * Returns human-readable label for a jurisdiction.
 */
export function getJurisdictionLabel(jurisdiction) {
  return JURISDICTION_LABELS[jurisdiction] || jurisdiction || 'United States'
}

/**
 * Returns true if the provider runs on-device / locally without remote data transmission.
 */
export function isOnDevice(providerOrId) {
  if (!providerOrId) return false
  if (typeof providerOrId === 'object') {
    if (providerOrId.local === true) return true
    if (providerOrId.jurisdiction === JURISDICTIONS.ON_DEVICE) return true
  }
  const jur = getProviderJurisdiction(providerOrId)
  return jur === JURISDICTIONS.ON_DEVICE
}

export const isLocalProvider = isOnDevice

/**
 * Determines whether the provider requires informed consent prior to data transmission.
 * External cloud providers require consent; on-device processing is bypassed.
 */
export function requiresConsent(providerOrId) {
  return !isOnDevice(providerOrId)
}

/**
 * Checks whether valid consent has been granted for the specific provider and its jurisdiction.
 * Returns true if:
 * 1. The provider is on-device (on-device bypass).
 * 2. Active consent exists for the specified external provider & jurisdiction.
 * Returns false if:
 * 1. No consent has been recorded.
 * 2. The user has switched to a different provider or jurisdiction without re-consenting.
 * 3. Consent has been revoked or version is outdated.
 */
export function hasCoachConsent(S, currentProvider) {
  if (!S) return false

  // If a provider was explicitly passed and is on-device, bypass consent requirement
  if (currentProvider && !requiresConsent(currentProvider)) {
    return true
  }

  // Determine current active provider
  const provider = currentProvider || S.config?.coach?.provider || S.coach?.provider
  if (provider && !requiresConsent(provider)) {
    return true
  }

  const effectiveProvider = normalizeProviderId(provider || 'anthropic')
  const effectiveJurisdiction = getProviderJurisdiction(provider || effectiveProvider)

  // Look up consent in S.privacy.consents.coach or S.coach.consent
  const consent = S.privacy?.consents?.coach || S.coach?.consent
  if (!consent || !consent.agreedAt || consent.revokedAt) {
    return false
  }

  if (consent.version && consent.version !== CONSENT_VERSION) {
    return false
  }

  // Must have a recorded provider matching current provider
  if (!consent.provider) {
    return false
  }
  if (normalizeProviderId(consent.provider) !== effectiveProvider) {
    return false
  }

  // Must match jurisdiction
  if (consent.jurisdiction && consent.jurisdiction !== effectiveJurisdiction) {
    return false
  }

  return true
}

/**
 * Returns true if re-consent is required for the specified provider.
 */
export function needsReconsent(S, currentProvider) {
  if (!requiresConsent(currentProvider)) return false
  return !hasCoachConsent(S, currentProvider)
}

export const shouldPromptConsent = needsReconsent

/**
 * Grants consent for Coach with the specified provider and jurisdiction.
 * Updates both S.privacy.consents.coach and S.coach.consent.
 */
export function grantCoachConsent(S, providerOrId, details = {}) {
  if (!S) return null
  const provider = normalizeProviderId(providerOrId || details.provider || 'anthropic')
  const jurisdiction = details.jurisdiction || getProviderJurisdiction(provider)
  const preset = getProviderPreset(provider)
  const recipient = details.recipient || preset?.label || provider
  const now = details.agreedAt || new Date().toISOString()
  const version = details.version || CONSENT_VERSION

  if (!S.privacy) S.privacy = { consents: {} }
  if (!S.privacy.consents) S.privacy.consents = {}

  const prev = S.privacy.consents.coach || {}
  const record = {
    ...prev,
    ...details,
    agreedAt: now,
    revokedAt: null,
    provider,
    jurisdiction,
    recipient,
    version
  }
  S.privacy.consents.coach = record

  if (S.coach) {
    S.coach.consent = {
      agreedAt: now,
      version,
      provider,
      jurisdiction
    }
  }

  return record
}

/**
 * Revokes consent for Coach, setting revokedAt timestamp and clearing active consent.
 */
export function revokeCoachConsent(S) {
  if (!S) return
  const now = new Date().toISOString()
  if (S.privacy?.consents?.coach) {
    S.privacy.consents.coach = {
      ...S.privacy.consents.coach,
      agreedAt: null,
      revokedAt: now
    }
  }
  if (S.coach) {
    S.coach.consent = null
    S.coach.cadence = 'off'
  }
}

/**
 * Returns the active Coach consent record, or null.
 */
export function getCoachConsent(S) {
  return S?.privacy?.consents?.coach || S?.coach?.consent || null
}

/**
 * Builds a ConsentSheet-compatible feature configuration for Coach and the specified provider.
 */
export function buildCoachConsentFeature(providerOrId = 'anthropic', overrides = {}) {
  const provider = normalizeProviderId(providerOrId)
  const jurisdiction = getProviderJurisdiction(provider)
  const jurisdictionLabel = getJurisdictionLabel(jurisdiction)
  const preset = getProviderPreset(provider)

  return {
    id: 'coach',
    name: 'AI Coach',
    provider,
    jurisdiction,
    jurisdictionLabel,
    recipient: preset?.label || provider,
    recipientUrl: preset?.endpoint || '',
    triggerTiming: 'On-demand when requesting training plan generation or review',
    payloadSummary: 'Plan routines, exercise sets, logged weights, reps, RIR/RPE ratings, and bodyweight goals.',
    revocationInstructions: 'Toggle off at any time. Revoking consent halts remote requests and clears cached AI proposals.',
    icon: 'sparkles',
    tint: 'var(--acc)',
    ...overrides
  }
}
