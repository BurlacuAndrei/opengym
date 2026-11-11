import React from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import { Section, Row, Switch } from '../components/ui.jsx'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import {
  EXTERNAL_FEATURES,
  hasConsent,
  getConsent,
  revokeConsent,
  formatConsentDate
} from '../lib/privacy.js'
import { openConsentSheet } from '../components/ConsentSheet.jsx'

export default function PrivacySettings() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)

  const handleToggle = (feature, currentConsent) => {
    if (currentConsent) {
      update(s => {
        revokeConsent(s, feature.id)
      })
      toast(t('Consent revoked for {0}', t(feature.name)))
    } else {
      openConsentSheet(feature)
    }
  }

  const showDetail = feature => {
    openConsentSheet(feature)
  }

  return (
    <div className="screen-pad">
      <div className="topbar">
        <button className="iconbtn" onClick={() => nav(-1)} aria-label={t('Back')}>
          <Icon name="chevronLeft" />
        </button>
        <div style={{ flex: 1, marginLeft: 10 }}>
          <h1>{t('Privacy')}</h1>
        </div>
      </div>

      <p className="sect-f" style={{ marginBottom: 20 }}>
        {t('Manage informed consent for external services and connected features. Data is never shared without your explicit consent.')}
      </p>

      <Section
        title={t('External features')}
        footer={t('You can review disclosures or revoke permission at any time. Revoking consent takes effect immediately.')}
      >
        {EXTERNAL_FEATURES.map(f => {
          const consented = hasConsent(S, f.id)
          const record = getConsent(S, f.id)
          const statusText = consented
            ? record?.agreedAt
              ? t('Granted {0}', formatConsentDate(record.agreedAt))
              : t('Granted')
            : t('Off')

          const subtitle = `${t(f.recipient)} · ${statusText}`

          return (
            <Row
              key={f.id}
              icon={f.icon || 'shield'}
              iconTint={f.tint || 'var(--acc)'}
              title={t(f.name)}
              subtitle={subtitle}
              accessory="chevron"
              onClick={() => showDetail(f)}
            >
              <div
                onClick={e => e.stopPropagation()}
                style={{ display: 'flex', alignItems: 'center', marginRight: 4 }}
              >
                <Switch
                  checked={consented}
                  onChange={() => handleToggle(f, consented)}
                />
              </div>
            </Row>
          )
        })}
      </Section>

      <Section title={t('Local data')}>
        <Row
          icon="lock"
          iconTint="var(--teal)"
          title={t('Local-first storage')}
          subtitle={t('Workouts, plans, and history live on your device and are never sold or sent to third parties.')}
        />
      </Section>
    </div>
  )
}
