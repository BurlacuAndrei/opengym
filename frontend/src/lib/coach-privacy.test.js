import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CONSENT_VERSION,
  JURISDICTIONS,
  JURISDICTION_LABELS,
  PROVIDER_JURISDICTIONS,
  normalizeProviderId,
  getProviderJurisdiction,
  getJurisdictionLabel,
  isOnDevice,
  isLocalProvider,
  requiresConsent,
  hasCoachConsent,
  needsReconsent,
  grantCoachConsent,
  revokeCoachConsent,
  getCoachConsent,
  buildCoachConsentFeature
} from './coach-privacy.js'
import ConsentSheet from '../components/ConsentSheet.jsx'
import { useStore } from '../store/useStore.js'

describe('coach-privacy (Issue #61)', () => {
  beforeEach(() => {
    useStore.setState({
      S: {
        privacy: { consents: {} },
        coach: { consent: null, cadence: 'off', log: [], snapshots: [] }
      }
    })
  })

  describe('1. Jurisdiction mapping', () => {
    it('maps provider presets to correct jurisdictions', () => {
      // Anthropic -> US
      expect(getProviderJurisdiction('anthropic')).toBe('US')
      expect(getProviderJurisdiction('claude')).toBe('US')

      // OpenAI -> US
      expect(getProviderJurisdiction('openai')).toBe('US')

      // Groq -> US, OpenRouter -> US
      expect(getProviderJurisdiction('groq')).toBe('US')
      expect(getProviderJurisdiction('openrouter')).toBe('US')

      // Mistral -> EU
      expect(getProviderJurisdiction('mistral')).toBe('EU')

      // Ollama / local -> On-Device
      expect(getProviderJurisdiction('ollama')).toBe('On-Device')
      expect(getProviderJurisdiction('local')).toBe('On-Device')
      expect(getProviderJurisdiction('vllm')).toBe('On-Device')
    })

    it('handles object configs and overrides', () => {
      expect(getProviderJurisdiction({ provider: 'mistral' })).toBe('EU')
      expect(getProviderJurisdiction({ id: 'openai' })).toBe('US')
      expect(getProviderJurisdiction({ local: true })).toBe('On-Device')
      expect(getProviderJurisdiction({ jurisdiction: 'EU' })).toBe('EU')
    })

    it('provides human-readable labels for jurisdictions', () => {
      expect(getJurisdictionLabel('US')).toBe('United States')
      expect(getJurisdictionLabel('EU')).toBe('European Union')
      expect(getJurisdictionLabel('On-Device')).toBe('On-Device')
    })

    it('normalizes provider aliases correctly', () => {
      expect(normalizeProviderId('LOCAL')).toBe('ollama')
      expect(normalizeProviderId('vllm')).toBe('ollama')
      expect(normalizeProviderId('CLAUDE')).toBe('anthropic')
      expect(normalizeProviderId('mistral')).toBe('mistral')
    })
  })

  describe('2. Informed consent requirement and on-device bypass', () => {
    it('identifies on-device vs cloud providers', () => {
      expect(isOnDevice('ollama')).toBe(true)
      expect(isOnDevice('local')).toBe(true)
      expect(isOnDevice('vllm')).toBe(true)
      expect(isLocalProvider({ local: true })).toBe(true)

      expect(isOnDevice('anthropic')).toBe(false)
      expect(isOnDevice('openai')).toBe(false)
      expect(isOnDevice('mistral')).toBe(false)
    })

    it('requires consent for cloud providers, bypasses for on-device', () => {
      expect(requiresConsent('anthropic')).toBe(true)
      expect(requiresConsent('openai')).toBe(true)
      expect(requiresConsent('mistral')).toBe(true)
      expect(requiresConsent('groq')).toBe(true)

      expect(requiresConsent('ollama')).toBe(false)
      expect(requiresConsent('local')).toBe(false)
      expect(requiresConsent({ local: true })).toBe(false)
    })

    it('bypasses consent for on-device providers even without consent record', () => {
      const stateWithoutConsent = {
        privacy: { consents: {} },
        coach: { consent: null }
      }

      // Ollama and local providers bypass external consent requirement
      expect(hasCoachConsent(stateWithoutConsent, 'ollama')).toBe(true)
      expect(hasCoachConsent(stateWithoutConsent, 'local')).toBe(true)
      expect(hasCoachConsent(stateWithoutConsent, { local: true })).toBe(true)
      expect(needsReconsent(stateWithoutConsent, 'ollama')).toBe(false)
      expect(needsReconsent(stateWithoutConsent, 'local')).toBe(false)

      // External providers still require consent
      expect(hasCoachConsent(stateWithoutConsent, 'anthropic')).toBe(false)
      expect(hasCoachConsent(stateWithoutConsent, 'openai')).toBe(false)
      expect(hasCoachConsent(stateWithoutConsent, 'mistral')).toBe(false)
      expect(needsReconsent(stateWithoutConsent, 'anthropic')).toBe(true)
    })
  })

  describe('3. Initial consent granting and verification', () => {
    it('records consent with provider, jurisdiction, and recipient metadata', () => {
      const S = {
        privacy: { consents: {} },
        coach: { consent: null, cadence: 'off' }
      }

      const record = grantCoachConsent(S, 'anthropic')

      expect(record.provider).toBe('anthropic')
      expect(record.jurisdiction).toBe('US')
      expect(record.recipient).toBe('Anthropic')
      expect(record.agreedAt).toBeTruthy()
      expect(record.revokedAt).toBeNull()
      expect(record.version).toBe(CONSENT_VERSION)

      // Both S.privacy.consents.coach and S.coach.consent are populated
      expect(S.privacy.consents.coach.provider).toBe('anthropic')
      expect(S.privacy.consents.coach.jurisdiction).toBe('US')
      expect(S.coach.consent.provider).toBe('anthropic')
      expect(S.coach.consent.jurisdiction).toBe('US')

      // Now consent is granted for Anthropic
      expect(hasCoachConsent(S, 'anthropic')).toBe(true)
      expect(needsReconsent(S, 'anthropic')).toBe(false)
    })

    it('records consent for EU provider Mistral', () => {
      const S = {
        privacy: { consents: {} },
        coach: { consent: null }
      }

      grantCoachConsent(S, 'mistral')

      expect(S.privacy.consents.coach.provider).toBe('mistral')
      expect(S.privacy.consents.coach.jurisdiction).toBe('EU')
      expect(hasCoachConsent(S, 'mistral')).toBe(true)
    })
  })

  describe('4. Provider switching and re-consent triggers', () => {
    it('triggers re-consent when switching between cloud providers', () => {
      const S = {
        privacy: { consents: {} },
        coach: { consent: null }
      }

      // 1. Initial consent for Anthropic (US)
      grantCoachConsent(S, 'anthropic')
      expect(hasCoachConsent(S, 'anthropic')).toBe(true)

      // 2. Switching to Mistral (EU): re-consent required
      expect(hasCoachConsent(S, 'mistral')).toBe(false)
      expect(needsReconsent(S, 'mistral')).toBe(true)

      // 3. Switching to OpenAI (US): re-consent required even within same jurisdiction
      expect(hasCoachConsent(S, 'openai')).toBe(false)
      expect(needsReconsent(S, 'openai')).toBe(true)

      // 4. Switching back to Anthropic remains valid
      expect(hasCoachConsent(S, 'anthropic')).toBe(true)
      expect(needsReconsent(S, 'anthropic')).toBe(false)
    })

    it('updates consent record upon re-consent to new provider', () => {
      const S = {
        privacy: { consents: {} },
        coach: { consent: null }
      }

      // Initial consent for Anthropic (US)
      grantCoachConsent(S, 'anthropic')
      expect(hasCoachConsent(S, 'anthropic')).toBe(true)

      // Re-consent for Mistral (EU)
      grantCoachConsent(S, 'mistral')
      expect(hasCoachConsent(S, 'mistral')).toBe(true)
      expect(S.privacy.consents.coach.provider).toBe('mistral')
      expect(S.privacy.consents.coach.jurisdiction).toBe('EU')

      // Previous provider is no longer consented
      expect(hasCoachConsent(S, 'anthropic')).toBe(false)
      expect(needsReconsent(S, 'anthropic')).toBe(true)
    })
  })

  describe('5. Revocation', () => {
    it('revokes consent and disables coach', () => {
      const S = {
        privacy: { consents: {} },
        coach: { consent: null, cadence: 'weekly' }
      }

      grantCoachConsent(S, 'anthropic')
      expect(hasCoachConsent(S, 'anthropic')).toBe(true)

      revokeCoachConsent(S)
      expect(hasCoachConsent(S, 'anthropic')).toBe(false)
      expect(S.coach.consent).toBeNull()
      expect(S.coach.cadence).toBe('off')
      expect(S.privacy.consents.coach.agreedAt).toBeNull()
      expect(S.privacy.consents.coach.revokedAt).toBeTruthy()
    })
  })

  describe('6. buildCoachConsentFeature', () => {
    it('builds feature descriptor with provider and jurisdiction', () => {
      const mistralFeature = buildCoachConsentFeature('mistral')
      expect(mistralFeature.id).toBe('coach')
      expect(mistralFeature.provider).toBe('mistral')
      expect(mistralFeature.jurisdiction).toBe('EU')
      expect(mistralFeature.jurisdictionLabel).toBe('European Union')
      expect(mistralFeature.recipient).toBe('Mistral')
      expect(mistralFeature.recipientUrl).toBe('https://api.mistral.ai/v1/chat/completions')

      const anthropicFeature = buildCoachConsentFeature('anthropic')
      expect(anthropicFeature.provider).toBe('anthropic')
      expect(anthropicFeature.jurisdiction).toBe('US')
      expect(anthropicFeature.recipient).toBe('Anthropic')

      const ollamaFeature = buildCoachConsentFeature('ollama')
      expect(ollamaFeature.provider).toBe('ollama')
      expect(ollamaFeature.jurisdiction).toBe('On-Device')
      expect(ollamaFeature.recipient).toBe('Ollama (Local)')
    })
  })

  describe('7. ConsentSheet component integration with jurisdiction', () => {
    it('renders provider and jurisdiction in ConsentSheet', () => {
      const feature = buildCoachConsentFeature('mistral')
      const html = renderToStaticMarkup(
        React.createElement(ConsentSheet, {
          feature,
          consented: false
        })
      )

      expect(html).toContain('AI Coach')
      expect(html).toContain('Mistral')
      expect(html).toContain('Jurisdiction')
      expect(html).toContain('EU')
      expect(html).toContain('European Union')
      expect(html).toContain('I understand &amp; agree')
    })

    it('prompts re-consent when sheet is rendered for a different provider than active consent', () => {
      // User consented to Anthropic (US)
      const S = {
        privacy: {
          consents: {
            coach: {
              agreedAt: '2026-11-01T00:00:00.000Z',
              revokedAt: null,
              provider: 'anthropic',
              jurisdiction: 'US',
              recipient: 'Anthropic',
              version: 1
            }
          }
        },
        coach: {
          consent: {
            agreedAt: '2026-11-01T00:00:00.000Z',
            version: 1,
            provider: 'anthropic',
            jurisdiction: 'US'
          }
        }
      }
      useStore.setState({ S })

      // Open sheet for Mistral (EU) without forcing consented prop
      const mistralFeature = buildCoachConsentFeature('mistral')
      const html = renderToStaticMarkup(
        React.createElement(ConsentSheet, {
          feature: mistralFeature
        })
      )

      // Sheet should recognize provider mismatch and display agree button + notice
      expect(html).toContain('I understand &amp; agree')
      expect(html).not.toContain('Revoke consent')
      expect(html).toContain('Provider switch detected')
    })

    it('displays revoke button when sheet is rendered for currently consented provider', () => {
      const S = {
        privacy: {
          consents: {
            coach: {
              agreedAt: '2026-11-01T00:00:00.000Z',
              revokedAt: null,
              provider: 'mistral',
              jurisdiction: 'EU',
              recipient: 'Mistral',
              version: 1
            }
          }
        },
        coach: {
          consent: {
            agreedAt: '2026-11-01T00:00:00.000Z',
            version: 1,
            provider: 'mistral',
            jurisdiction: 'EU'
          }
        }
      }
      useStore.setState({ S })

      const mistralFeature = buildCoachConsentFeature('mistral')
      const html = renderToStaticMarkup(
        React.createElement(ConsentSheet, {
          feature: mistralFeature
        })
      )

      expect(html).toContain('Revoke consent')
      expect(html).toContain('Consent granted on')
    })
  })
})
