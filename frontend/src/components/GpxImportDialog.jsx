import React, { useState, useEffect } from 'react'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Button, Segmented, TextField } from './ui.jsx'
import { useUI } from '../store/useUI.js'
import { useStore, CARDIO_TYPES } from '../store/useStore.js'
import { fmtDist, formatElevation } from '../lib/cardio-format.js'
import { fmtDur } from '../lib/format.js'
import {
  parseGPXInput,
  importGPXAsActivity,
  importGPXAsRoute
} from '../lib/gpx-io.js'

/**
 * Dialog prompting user to import a GPX file either as a past completed
 * cardio activity or as a saved route.
 *
 * @param {Object} props
 * @param {File|Blob} [props.file] - File or Blob containing GPX data
 * @param {string} [props.xmlString] - Raw GPX XML string
 * @param {Object} [props.gpxData] - Pre-parsed GPX object
 * @param {string} [props.defaultDestination='activity'] - Initial destination ('activity' | 'route')
 * @param {Function} [props.onImport] - Callback when import finishes
 * @param {Function} [props.onCancel] - Callback when import is cancelled
 * @param {Function} [props.close] - Modal close callback
 */
export default function GpxImportDialog({
  file,
  xmlString,
  gpxData,
  defaultDestination = 'activity',
  onImport,
  onCancel,
  close
}) {
  const unit = useStore(s => s.S?.unit || 'kg')
  const [loading, setLoading] = useState(!gpxData && Boolean(file || xmlString))
  const [error, setError] = useState(null)
  const [parsed, setParsed] = useState(gpxData || null)
  const [destination, setDestination] = useState(defaultDestination)
  const [activityType, setActivityType] = useState('run')
  const [name, setName] = useState(gpxData?.name || '')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (gpxData) {
      setParsed(gpxData)
      if (gpxData.name && !name) setName(gpxData.name)
      setLoading(false)
      return
    }

    if (!file && !xmlString) {
      setError(t('No GPX data provided'))
      setLoading(false)
      return
    }

    let isMounted = true
    setLoading(true)
    setError(null)

    parseGPXInput(file || xmlString)
      .then(result => {
        if (!isMounted) return
        setParsed(result)
        setName(result.name || '')
        setLoading(false)
      })
      .catch(err => {
        if (!isMounted) return
        setError(err.message || t('Failed to parse GPX'))
        setLoading(false)
      })

    return () => {
      isMounted = false
    }
  }, [file, xmlString, gpxData])

  const handleCancel = () => {
    onCancel?.()
    close?.()
  }

  const handleImport = async () => {
    if (!parsed) return
    setSubmitting(true)
    try {
      let result = null
      if (destination === 'route') {
        result = await importGPXAsRoute(parsed, {
          name: name.trim() || parsed.name || t('Imported Route'),
          desc: parsed.desc || ''
        })
        useUI.getState().toast(t('Route saved'))
      } else {
        result = await importGPXAsActivity(parsed, {
          type: activityType,
          name: name.trim() || parsed.name || t('Imported Activity'),
          notes: parsed.desc || ''
        })
        useUI.getState().toast(t('Activity imported'))
      }

      onImport?.(result)
      close?.()
    } catch (err) {
      setError(err.message || t('Import failed'))
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 12px', minWidth: 280 }}>
        <div style={{ marginBottom: 12 }}>
          <Icon name="timer" size={28} />
        </div>
        <div className="muted">{t('Parsing GPX track…')}</div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '16px 8px', minWidth: 280 }}>
        <h3 style={{ marginBottom: 8, color: 'var(--red, #ef4444)' }}>{t('GPX Import Error')}</h3>
        <div className="muted small" style={{ marginBottom: 18, lineHeight: 1.5 }}>
          {error}
        </div>
        <Button variant="ghost" style={{ width: '100%' }} onClick={handleCancel}>
          {t('Dismiss')}
        </Button>
      </div>
    )
  }

  const summary = parsed?.summary || {}
  const distanceM = summary.totalDistance || 0
  const durationSec = summary.movingTime || summary.elapsedTime || 0
  const durationMs = Math.round(durationSec * 1000)
  const eleGain = summary.elevationGain || 0
  const pointCount = parsed?.points?.length || 0

  return (
    <div style={{ padding: '4px 0', minWidth: 280, maxWidth: 420 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: 'var(--surface-2, rgba(148, 163, 184, 0.15))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent, #30d158)'
          }}
        >
          <Icon name="chartLine" size={20} />
        </div>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.15rem' }}>{t('Import GPX')}</h3>
          <div className="muted small">{pointCount} {t('GPS trackpoints')}</div>
        </div>
      </div>

      {/* Track metrics preview */}
      <div
        className="tiles"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 8,
          marginBottom: 14
        }}
      >
        <div className="tile" style={{ padding: 10, borderRadius: 8, background: 'var(--surface-2, rgba(148, 163, 184, 0.08))' }}>
          <div className="l small muted">{t('Distance')}</div>
          <div className="v" style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            {fmtDist(distanceM, unit)}
          </div>
        </div>

        {durationMs > 0 && (
          <div className="tile" style={{ padding: 10, borderRadius: 8, background: 'var(--surface-2, rgba(148, 163, 184, 0.08))' }}>
            <div className="l small muted">{t('Duration')}</div>
            <div className="v" style={{ fontSize: '1.1rem', fontWeight: 600 }}>
              {fmtDur(durationMs)}
            </div>
          </div>
        )}

        {eleGain > 0 && (
          <div className="tile" style={{ padding: 10, borderRadius: 8, background: 'var(--surface-2, rgba(148, 163, 184, 0.08))' }}>
            <div className="l small muted">{t('Elevation Gain')}</div>
            <div className="v" style={{ fontSize: '1.1rem', fontWeight: 600 }}>
              +{formatElevation(eleGain, unit)}
            </div>
          </div>
        )}

        <div className="tile" style={{ padding: 10, borderRadius: 8, background: 'var(--surface-2, rgba(148, 163, 184, 0.08))' }}>
          <div className="l small muted">{t('Trackpoints')}</div>
          <div className="v" style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            {pointCount}
          </div>
        </div>
      </div>

      {/* Name Input */}
      <div style={{ marginBottom: 14 }}>
        <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
          {t('Title')}
        </label>
        <TextField
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={destination === 'route' ? t('Route name') : t('Activity name')}
          autoFocus={false}
        />
      </div>

      {/* Destination toggle */}
      <div style={{ marginBottom: 14 }}>
        <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
          {t('Import as')}
        </label>
        <Segmented
          options={[
            { value: 'activity', label: t('Past Activity') },
            { value: 'route', label: t('Saved Route') }
          ]}
          value={destination}
          onChange={setDestination}
        />
      </div>

      {/* Activity Type (if destination === 'activity') */}
      {destination === 'activity' && (
        <div style={{ marginBottom: 16 }}>
          <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
            {t('Activity Type')}
          </label>
          <Segmented
            options={CARDIO_TYPES.map(type => ({
              value: type,
              label: t(type.charAt(0).toUpperCase() + type.slice(1))
            }))}
            value={activityType}
            onChange={setActivityType}
          />
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <Button
          variant="primary"
          style={{ width: '100%' }}
          onClick={handleImport}
          disabled={submitting}
        >
          {destination === 'route' ? t('Import as Route') : t('Import as Activity')}
        </Button>

        <Button
          variant="ghost"
          className="dim"
          style={{ width: '100%' }}
          onClick={handleCancel}
          disabled={submitting}
        >
          {t('Cancel')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Convenience helper to open the GPX import dialog in the centered UI sheet.
 *
 * @param {Object} options - Options passed to GpxImportDialog
 * @returns {string|number} Sheet handle
 */
export function openGpxImportDialog(options = {}) {
  return useUI.getState().openSheet(
    close => <GpxImportDialog {...options} close={close} />,
    { kind: 'center' }
  )
}
