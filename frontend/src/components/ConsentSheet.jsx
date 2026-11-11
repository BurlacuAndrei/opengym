import React from 'react'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'
import { useUI } from '../store/useUI.js'
import { useStore } from '../store/useStore.js'
import { hasConsent, getConsent, grantConsent, revokeConsent, formatConsentDate } from '../lib/privacy.js'
import { hasCoachConsent, grantCoachConsent, revokeCoachConsent, getCoachConsent, buildCoachConsentFeature } from '../lib/coach-privacy.js'

/**
 * Reusable informed-consent sheet modal displaying:
 * - recipient link
 * - payload summary
 * - trigger timing
 * - revocation instructions
 * - timestamped grant status
 */
export default function ConsentSheet({
  feature,
  close,
  onAgree,
  onRevoke,
  onCancel,
  consented,
  record: propRecord
}) {
  const storeS = useStore?.getState?.()?.S
  const hookS = useStore ? useStore(s => s.S) : null
  const S = storeS || hookS
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)

  const featureId = feature?.id
  const record = propRecord || (featureId === 'coach' ? getCoachConsent(S) : getConsent(S, featureId)) || (feature?.agreedAt ? feature : null)

  // Per-provider jurisdiction check:
  // If feature specifies a provider or jurisdiction, consent is only valid if record matches both.
  const providerMatches = !feature?.provider || !record?.provider || record.provider === feature.provider
  const jurisdictionMatches = !feature?.jurisdiction || !record?.jurisdiction || record.jurisdiction === feature.jurisdiction
  const matchesCurrentPreset = providerMatches && jurisdictionMatches

  const defaultConsented = featureId === 'coach' && feature?.provider
    ? hasCoachConsent(S, feature.provider)
    : hasConsent(S, featureId) && matchesCurrentPreset

  const isConsented = consented !== undefined ? consented : defaultConsented

  const handleAgree = () => {
    if (update && featureId) {
      update(s => {
        if (featureId === 'coach' && feature?.provider) {
          grantCoachConsent(s, feature.provider, {
            recipient: feature?.recipient || '',
            name: feature?.name || '',
            jurisdiction: feature?.jurisdiction || ''
          })
        } else {
          grantConsent(s, featureId, {
            recipient: feature?.recipient || '',
            name: feature?.name || '',
            provider: feature?.provider || '',
            jurisdiction: feature?.jurisdiction || ''
          })
        }
      })
    }
    toast(t('Consent granted for {0}', t(feature?.name || 'feature')))
    onAgree?.()
    close?.()
  }

  const handleRevoke = () => {
    if (update && featureId) {
      update(s => {
        if (featureId === 'coach') {
          revokeCoachConsent(s)
        } else {
          revokeConsent(s, featureId)
        }
      })
    }
    toast(t('Consent revoked for {0}', t(feature?.name || 'feature')))
    onRevoke?.()
    close?.()
  }

  const handleClose = () => {
    onCancel?.()
    close?.()
  }

  const recipientLabel = t(feature?.recipient || 'openGym')

  return (
    <div className="consent-sheet" style={{ padding: '4px 0' }}>
      <div className="row" style={{ gap: 10, marginBottom: 12 }}>
        <span className="lrow-i" style={{ '--tint': feature?.tint || 'var(--acc)' }}>
          <Icon name={feature?.icon || 'shield'} />
        </span>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>{t(feature?.name || 'Informed consent')}</h3>
          <div className="muted small" style={{ marginTop: 2 }}>
            {t('Recipient')}:{' '}
            {feature?.recipientUrl ? (
              <a
                href={feature.recipientUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--tint, var(--acc))', textDecoration: 'underline' }}
              >
                {recipientLabel}
              </a>
            ) : (
              <span>{recipientLabel}</span>
            )}
            {feature?.jurisdiction && (
              <span style={{ marginLeft: 6 }}>
                ({t('Jurisdiction')}: <strong>{t(feature.jurisdiction)}</strong>)
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="sect-b" style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
        {/* Data destination / Jurisdiction */}
        {feature?.jurisdiction && (
          <div>
            <div className="muted small" style={{ fontWeight: 600, marginBottom: 2 }}>
              {t('Data destination')}
            </div>
            <div className="small" style={{ lineHeight: 1.5 }}>
              {t(feature.jurisdictionLabel ? `${feature.jurisdictionLabel} (${feature.jurisdiction})` : feature.jurisdiction)}
            </div>
          </div>
        )}

        {/* Payload summary */}
        <div>
          <div className="muted small" style={{ fontWeight: 600, marginBottom: 2 }}>
            {t('Data shared')}
          </div>
          <div className="small" style={{ lineHeight: 1.5 }}>
            {t(feature?.payloadSummary || 'No external personal data shared.')}
          </div>
        </div>

        {/* Trigger timing */}
        <div>
          <div className="muted small" style={{ fontWeight: 600, marginBottom: 2 }}>
            {t('When it is sent')}
          </div>
          <div className="small" style={{ lineHeight: 1.5 }}>
            {t(feature?.triggerTiming || 'Only with explicit user interaction.')}
          </div>
        </div>

        {/* Revocation instructions */}
        <div>
          <div className="muted small" style={{ fontWeight: 600, marginBottom: 2 }}>
            {t('How to revoke')}
          </div>
          <div className="small" style={{ lineHeight: 1.5 }}>
            {t(feature?.revocationInstructions || 'You can revoke permission anytime in Settings -> Privacy.')}
          </div>
        </div>

        {/* Consent status / timestamp */}
        {record?.agreedAt && !record?.revokedAt && matchesCurrentPreset && (
          <div className="dim small" style={{ marginTop: 4 }}>
            {t('Consent granted on {0}', formatConsentDate(record.agreedAt))}
          </div>
        )}
        {record?.agreedAt && !record?.revokedAt && !matchesCurrentPreset && (
          <div className="dim small" style={{ marginTop: 4, color: 'var(--amber, #f59e0b)' }}>
            {t('Provider switch detected. Please review and re-confirm consent for {0}.',
              feature?.provider || recipientLabel
            )}
          </div>
        )}
        {record?.revokedAt && (
          <div className="dim small" style={{ marginTop: 4, color: 'var(--red)' }}>
            {t('Consent revoked on {0}', formatConsentDate(record.revokedAt))}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {isConsented ? (
          <>
            <Button variant="danger" onClick={handleRevoke}>
              {t('Revoke consent')}
            </Button>
            <Button onClick={handleClose}>{t('Close')}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleAgree}>
              {t('I understand & agree')}
            </Button>
            <Button onClick={handleClose}>{t('Not now')}</Button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Convenience helper to open the ConsentSheet modal dialog.
 */
export function openConsentSheet(feature, opts = {}) {
  return useUI.getState().openSheet(close => (
    <ConsentSheet feature={feature} close={close} {...opts} />
  ))
}

/**
 * Convenience helper to open the ConsentSheet modal dialog for AI Coach with provider jurisdiction.
 */
export function openCoachConsentSheet(providerOrId, opts = {}) {
  const feature = buildCoachConsentFeature(providerOrId, opts?.feature)
  return openConsentSheet(feature, opts)
}
