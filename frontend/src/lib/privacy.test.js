import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import {
  EXTERNAL_FEATURES,
  getPrivacy,
  getConsent,
  hasConsent,
  checkConsent,
  grantConsent,
  revokeConsent,
  listConsents,
  formatConsentDate,
  CONSENT_VERSION
} from './privacy.js'
import {
  useStore,
  DEF,
  grantConsent as storeGrantConsent,
  revokeConsent as storeRevokeConsent,
  hasConsent as storeHasConsent,
  getConsent as storeGetConsent
} from '../store/useStore.js'
import ConsentSheet from '../components/ConsentSheet.jsx'
import PrivacySettings from '../views/PrivacySettings.jsx'

if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store }
  }
}

describe('privacy & consent management (Issue #39)', () => {
  describe('EXTERNAL_FEATURES registry', () => {
    it('defines external features with disclosures', () => {
      expect(EXTERNAL_FEATURES.length).toBeGreaterThanOrEqual(4)
      const ids = EXTERNAL_FEATURES.map(f => f.id)
      expect(ids).toContain('coach')
      expect(ids).toContain('server_sync')
      expect(ids).toContain('cardio_gps')
      expect(ids).toContain('notifications')

      for (const feat of EXTERNAL_FEATURES) {
        expect(feat.id).toBeTruthy()
        expect(feat.name).toBeTruthy()
        expect(feat.recipient).toBeTruthy()
        expect(feat.payloadSummary).toBeTruthy()
        expect(feat.triggerTiming).toBeTruthy()
        expect(feat.revocationInstructions).toBeTruthy()
      }
    })
  })

  describe('pure helpers (getPrivacy, getConsent, hasConsent, grantConsent, revokeConsent)', () => {
    it('handles empty or uninitialized state gracefully', () => {
      expect(getPrivacy(null)).toEqual({ consents: {} })
      expect(getPrivacy({})).toEqual({ consents: {} })
      expect(getConsent(null, 'coach')).toBeNull()
      expect(getConsent({}, 'coach')).toBeNull()
      expect(hasConsent(null, 'coach')).toBe(false)
      expect(hasConsent({}, 'coach')).toBe(false)
      expect(checkConsent({}, 'coach')).toBe(false)
    })

    it('grants consent with ISO timestamp, recipient, and version', () => {
      const S = {}
      const record = grantConsent(S, 'coach', { recipient: 'OpenAI API' })

      expect(record).toBeTruthy()
      expect(record.recipient).toBe('OpenAI API')
      expect(record.version).toBe(CONSENT_VERSION)
      expect(record.revokedAt).toBeNull()
      expect(typeof record.agreedAt).toBe('string')
      expect(new Date(record.agreedAt).getTime()).not.toBeNaN()

      expect(hasConsent(S, 'coach')).toBe(true)
      expect(checkConsent(S, 'coach')).toBe(true)
      expect(getConsent(S, 'coach')).toEqual(record)
      expect(listConsents(S).coach).toEqual(record)
    })

    it('revokes consent with ISO timestamp and sets agreedAt to null', () => {
      const S = {}
      grantConsent(S, 'server_sync', { recipient: 'openGym instance' })
      expect(hasConsent(S, 'server_sync')).toBe(true)

      const revoked = revokeConsent(S, 'server_sync')
      expect(revoked.agreedAt).toBeNull()
      expect(typeof revoked.revokedAt).toBe('string')
      expect(new Date(revoked.revokedAt).getTime()).not.toBeNaN()
      expect(hasConsent(S, 'server_sync')).toBe(false)
    })

    it('re-granting resets revokedAt to null and updates agreedAt timestamp', () => {
      const S = {}
      grantConsent(S, 'cardio_gps')
      revokeConsent(S, 'cardio_gps')
      expect(hasConsent(S, 'cardio_gps')).toBe(false)

      const regranted = grantConsent(S, 'cardio_gps', { recipient: 'GPS sensor' })
      expect(regranted.agreedAt).toBeTruthy()
      expect(regranted.revokedAt).toBeNull()
      expect(hasConsent(S, 'cardio_gps')).toBe(true)
    })

    it('syncs with coach backwards compatibility', () => {
      // Legacy coach consent in S.coach.consent
      const legacyState = {
        coach: { consent: { agreedAt: '2026-08-01T00:00:00.000Z', version: 1 } }
      }
      expect(hasConsent(legacyState, 'coach')).toBe(true)

      // Granting coach updates S.coach.consent too
      const stateWithCoach = { coach: { consent: null, cadence: 'weekly' } }
      grantConsent(stateWithCoach, 'coach')
      expect(stateWithCoach.coach.consent?.agreedAt).toBeTruthy()

      // Revoking coach clears S.coach.consent and disables cadence
      revokeConsent(stateWithCoach, 'coach')
      expect(stateWithCoach.coach.consent).toBeNull()
      expect(stateWithCoach.coach.cadence).toBe('off')
      expect(hasConsent(stateWithCoach, 'coach')).toBe(false)
    })

    it('formats consent dates safely', () => {
      expect(formatConsentDate('')).toBe('')
      expect(formatConsentDate(null)).toBe('')
      const formatted = formatConsentDate('2026-11-11T20:00:00.000Z')
      expect(formatted).toBeTruthy()
      expect(typeof formatted).toBe('string')
    })
  })

  describe('useStore integration', () => {
    beforeEach(() => {
      useStore.setState({
        S: JSON.parse(JSON.stringify(DEF))
      })
    })

    it('DEF includes privacy defaults', () => {
      expect(DEF.privacy).toEqual({ consents: {} })
      expect(useStore.getState().S.privacy).toEqual({ consents: {} })
    })

    it('grantConsent, revokeConsent, hasConsent, getConsent work via store methods', () => {
      const store = useStore.getState()
      expect(store.hasConsent('coach')).toBe(false)

      store.grantConsent('coach', { recipient: 'Provider X' })
      expect(useStore.getState().hasConsent('coach')).toBe(true)
      const consent = useStore.getState().getConsent('coach')
      expect(consent.agreedAt).toBeTruthy()
      expect(consent.recipient).toBe('Provider X')

      store.revokeConsent('coach')
      expect(useStore.getState().hasConsent('coach')).toBe(false)
      expect(useStore.getState().getConsent('coach').revokedAt).toBeTruthy()
    })

    it('standalone store export wrappers function identically', () => {
      expect(storeHasConsent('notifications')).toBe(false)

      storeGrantConsent('notifications', { recipient: 'Push Gateway' })
      expect(storeHasConsent('notifications')).toBe(true)
      expect(storeGetConsent('notifications').recipient).toBe('Push Gateway')

      storeRevokeConsent('notifications')
      expect(storeHasConsent('notifications')).toBe(false)
    })
  })

  describe('ConsentSheet component rendering', () => {
    const testFeature = {
      id: 'coach',
      name: 'AI Coach',
      recipient: 'Configured AI Provider',
      recipientUrl: 'https://example.com/privacy',
      triggerTiming: 'When requesting plan generation',
      payloadSummary: 'Workouts, routine names, bodyweight',
      revocationInstructions: 'Toggle off in Privacy Settings',
      icon: 'sparkles',
      tint: 'var(--acc)'
    }

    it('renders recipient link, payload summary, trigger timing, revocation instructions', () => {
      const html = renderToStaticMarkup(
        React.createElement(ConsentSheet, {
          feature: testFeature,
          consented: false
        })
      )

      expect(html).toContain('AI Coach')
      expect(html).toContain('https://example.com/privacy')
      expect(html).toContain('Configured AI Provider')
      expect(html).toContain('Workouts, routine names, bodyweight')
      expect(html).toContain('When requesting plan generation')
      expect(html).toContain('Toggle off in Privacy Settings')
      expect(html).toContain('I understand &amp; agree')
    })

    it('renders revoke button and timestamp when consented', () => {
      const record = {
        agreedAt: '2026-11-10T12:00:00.000Z',
        recipient: 'Configured AI Provider',
        revokedAt: null
      }
      useStore.setState({
        S: {
          ...DEF,
          privacy: {
            consents: {
              coach: record
            }
          }
        }
      })

      const html = renderToStaticMarkup(
        React.createElement(ConsentSheet, {
          feature: testFeature,
          consented: true,
          record
        })
      )

      expect(html).toContain('Revoke consent')
      expect(html).toContain('Consent granted on')
    })
  })

  describe('PrivacySettings view rendering', () => {
    it('renders privacy center and external features section', () => {
      const html = renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(PrivacySettings)
        )
      )

      expect(html).toContain('Privacy')
      expect(html).toContain('External features')
      expect(html).toContain('AI Coach')
      expect(html).toContain('Server Sync')
      expect(html).toContain('Cardio GPS &amp; Location')
      expect(html).toContain('Push Notifications')
      expect(html).toContain('Local-first storage')
    })
  })
})
