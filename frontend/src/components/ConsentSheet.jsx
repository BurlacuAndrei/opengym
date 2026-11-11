import React from 'react'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'
import { useUI } from '../store/useUI.js'
import { useStore } from '../store/useStore.js'
import { hasConsent, getConsent, grantConsent, revokeConsent, formatConsentDate } from '../lib/privacy.js'

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
  const hookS = useStore(s => s.S)
  const S = hookS || storeS
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)

  const featureId = feature?.id
  const isConsented = consented !== undefined ? consented : hasConsent(S, featureId)
  const record = propRecord || getConsent(S, featureId) || (feature?.agreedAt ? feature : null)

  const handleAgree = () => {
    if (update && featureId) {
      update(s => {
        grantConsent(s, featureId, {
          recipient: feature?.recipient || '',
          name: feature?.name || ''
        })
      })
    }
    toast(t('Consent granted for {0}', t(feature?.name || 'feature')))
    onAgree?.()
    close?.()
  }

  const handleRevoke = () => {
    if (update && featureId) {
      update(s => {
        revokeConsent(s, featureId)
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
          </div>
        </div>
      </div>

      <div className="sect-b" style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
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
        {record?.agreedAt && !record?.revokedAt && (
          <div className="dim small" style={{ marginTop: 4 }}>
            {t('Consent granted on {0}', formatConsentDate(record.agreedAt))}
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
