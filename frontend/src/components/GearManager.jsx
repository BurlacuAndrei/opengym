import React, { useState } from 'react'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { TextField, Button, Segmented } from './ui.jsx'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_SHOE_MAX_DISTANCE_M,
  DEFAULT_BIKE_MAX_DISTANCE_M,
  isGearDueRetirement,
  getGearWearPercent,
  addGear,
  updateGear,
  retireGear
} from '../lib/gear.js'
import { fmtDist, formatDistance } from '../lib/cardio-format.js'

/**
 * GearManager component for managing gear list, viewing wear percentage
 * progress bar, adding/retiring gear. (Issue #54)
 */
export default function GearManager({ close, gear: propGear, unit: propUnit }) {
  const storeS = useStore?.getState?.()?.S
  const hookS = typeof useStore === 'function' ? useStore(s => s.S) : null
  const S = hookS || storeS || {}
  const unit = propUnit || S.unit || 'kg'
  const gearList = propGear || S.gear || []

  const [tab, setTab] = useState('active') // 'active' | 'retired'
  const [showAddForm, setShowAddForm] = useState(false)

  // Form state
  const [name, setName] = useState('')
  const [type, setType] = useState('shoe') // 'shoe' | 'bike'
  const [brand, setBrand] = useState('')
  const [model, setModel] = useState('')
  const [maxDistanceInput, setMaxDistanceInput] = useState('')
  const [initialDistanceInput, setInitialDistanceInput] = useState('')
  const [formError, setFormError] = useState('')

  const activeGear = gearList.filter(g => !g.isRetired)
  const retiredGear = gearList.filter(g => g.isRetired)

  const handleTypeChange = newType => {
    setType(newType)
    if (!maxDistanceInput) {
      // Default placeholder handles the default threshold
    }
  }

  const handleAddSubmit = e => {
    e?.preventDefault?.()
    if (!name.trim()) {
      setFormError(t('Please enter a gear name'))
      return
    }

    const isImperial = unit === 'lb' || unit === 'lbs'
    const METERS_PER_MI = 1609.344

    let maxDistM = type === 'bike' ? DEFAULT_BIKE_MAX_DISTANCE_M : DEFAULT_SHOE_MAX_DISTANCE_M
    if (maxDistanceInput && !isNaN(Number(maxDistanceInput))) {
      const val = Number(maxDistanceInput)
      maxDistM = isImperial ? Math.round(val * METERS_PER_MI) : Math.round(val * 1000)
    }

    let initialDistM = 0
    if (initialDistanceInput && !isNaN(Number(initialDistanceInput))) {
      const val = Number(initialDistanceInput)
      initialDistM = isImperial ? Math.round(val * METERS_PER_MI) : Math.round(val * 1000)
    }

    const newGear = {
      name: name.trim(),
      type,
      brand: brand.trim(),
      model: model.trim(),
      distanceM: Math.max(0, initialDistM),
      maxDistanceM: maxDistM,
      isRetired: false
    }

    addGear(newGear)

    // Reset form
    setName('')
    setBrand('')
    setModel('')
    setMaxDistanceInput('')
    setInitialDistanceInput('')
    setFormError('')
    setShowAddForm(false)
  }

  const handleRetire = id => {
    retireGear(id)
  }

  const handleReactivate = id => {
    updateGear(id, { isRetired: false })
  }

  const isImperial = unit === 'lb' || unit === 'lbs'
  const defaultThresholdFormatted =
    type === 'bike'
      ? isImperial ? '3000 mi' : '5000 km'
      : isImperial ? '500 mi' : '800 km'

  const displayedGear = tab === 'active' ? activeGear : retiredGear

  return (
    <div className="gear-manager" style={{ padding: '16px', maxWidth: 600, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="gear" /> {t('Gear Tracker')}
        </h2>
        {close && (
          <button
            type="button"
            className="iconbtn"
            onClick={close}
            aria-label={t('Close')}
            style={{ width: 36, height: 36 }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Action / Add button */}
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Segmented
          options={[
            { value: 'active', label: `${t('Active')} (${activeGear.length})` },
            { value: 'retired', label: `${t('Retired')} (${retiredGear.length})` }
          ]}
          value={tab}
          onChange={setTab}
        />
        <Button
          variant={showAddForm ? 'plain' : 'primary'}
          size="small"
          onClick={() => setShowAddForm(v => !v)}
        >
          {showAddForm ? t('Cancel') : `+ ${t('Add Gear')}`}
        </Button>
      </div>

      {/* Add Gear Form */}
      {showAddForm && (
        <form
          onSubmit={handleAddSubmit}
          style={{
            background: 'var(--surface-2, #1e1e1e)',
            borderRadius: 10,
            padding: 16,
            marginBottom: 20,
            border: '1px solid var(--border, #333)'
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 12 }}>{t('Add New Gear')}</div>

          {formError && (
            <div style={{ color: 'var(--red, #e05252)', fontSize: 13, marginBottom: 10 }}>
              {formError}
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
              {t('Gear Type')}
            </label>
            <Segmented
              options={[
                { value: 'shoe', label: t('Running Shoes') },
                { value: 'bike', label: t('Bicycle') }
              ]}
              value={type}
              onChange={handleTypeChange}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
              {t('Gear Name')} *
            </label>
            <TextField
              placeholder={type === 'bike' ? t('e.g. Canyon Endurace') : t('e.g. Pegasus 40')}
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
                {t('Brand (optional)')}
              </label>
              <TextField
                placeholder={type === 'bike' ? t('e.g. Trek') : t('e.g. Nike')}
                value={brand}
                onChange={e => setBrand(e.target.value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
                {t('Model (optional)')}
              </label>
              <TextField
                placeholder={type === 'bike' ? t('e.g. Domane') : t('e.g. ZoomX')}
                value={model}
                onChange={e => setModel(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
                {t('Retirement Threshold')} ({isImperial ? 'mi' : 'km'})
              </label>
              <TextField
                type="number"
                placeholder={defaultThresholdFormatted}
                value={maxDistanceInput}
                onChange={e => setMaxDistanceInput(e.target.value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
                {t('Initial Distance')} ({isImperial ? 'mi' : 'km'})
              </label>
              <TextField
                type="number"
                placeholder="0"
                value={initialDistanceInput}
                onChange={e => setInitialDistanceInput(e.target.value)}
              />
            </div>
          </div>

          <Button type="submit" variant="primary" style={{ width: '100%' }}>
            {t('Save Gear')}
          </Button>
        </form>
      )}

      {/* Gear List */}
      {displayedGear.length === 0 ? (
        <div
          style={{
            padding: '36px 16px',
            textAlign: 'center',
            color: 'var(--muted, #888)',
            background: 'var(--surface-1, #161616)',
            borderRadius: 10
          }}
        >
          {tab === 'active'
            ? t('No active gear yet. Track mileage on your running shoes and bikes.')
            : t('No retired gear.')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {displayedGear.map(item => {
            const wearPct = getGearWearPercent(item)
            const dueRetirement = isGearDueRetirement(item)
            const iconName = item.type === 'bike' ? 'bike' : 'figureRun'

            return (
              <div
                key={item.id}
                className="gear-card"
                style={{
                  background: 'var(--surface-2, #1e1e1e)',
                  borderRadius: 10,
                  padding: 14,
                  border: dueRetirement
                    ? '1px solid var(--red, #e05252)'
                    : '1px solid var(--border, #2a2a2a)',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.2)'
                }}
              >
                {/* Gear header info */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 34,
                        height: 34,
                        borderRadius: 8,
                        background: 'var(--surface-3, #2c2c2c)',
                        color: 'var(--acc, #c8ff00)'
                      }}
                    >
                      <Icon name={iconName} />
                    </span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>{item.name}</div>
                      {(item.brand || item.model) && (
                        <div className="muted small" style={{ fontSize: 12 }}>
                          {[item.brand, item.model].filter(Boolean).join(' ')}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Retire / Reactivate Action */}
                  {item.isRetired ? (
                    <Button
                      variant="plain"
                      size="small"
                      onClick={() => handleReactivate(item.id)}
                    >
                      {t('Reactivate')}
                    </Button>
                  ) : (
                    <Button
                      variant="plain"
                      size="small"
                      onClick={() => handleRetire(item.id)}
                    >
                      {t('Retire')}
                    </Button>
                  )}
                </div>

                {/* Progress bar and metrics */}
                <div style={{ marginBottom: 6 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      color: 'var(--muted, #888)',
                      marginBottom: 4
                    }}
                  >
                    <span>
                      {formatDistance(item.distanceM, unit)} / {formatDistance(item.maxDistanceM, unit)}
                    </span>
                    <span style={{ fontWeight: 600, color: dueRetirement ? 'var(--red, #e05252)' : 'inherit' }}>
                      {wearPct}% {t('wear')}
                    </span>
                  </div>

                  {/* Wear progress bar */}
                  <div
                    className="wear-progress-bar-bg"
                    style={{
                      width: '100%',
                      height: 6,
                      borderRadius: 3,
                      background: 'var(--surface-3, #333)',
                      overflow: 'hidden'
                    }}
                  >
                    <div
                      className="wear-progress-bar-fill"
                      style={{
                        width: `${Math.min(100, wearPct)}%`,
                        height: '100%',
                        background: dueRetirement
                          ? 'var(--red, #e05252)'
                          : wearPct >= 80
                          ? 'var(--yellow, #e5a93c)'
                          : 'var(--acc, #c8ff00)',
                        borderRadius: 3,
                        transition: 'width 0.3s ease'
                      }}
                    />
                  </div>
                </div>

                {/* Retirement alert banner */}
                {dueRetirement && (
                  <div
                    className="retirement-alert"
                    style={{
                      marginTop: 8,
                      padding: '6px 10px',
                      borderRadius: 6,
                      background: 'rgba(224, 82, 82, 0.15)',
                      color: 'var(--red, #e05252)',
                      fontSize: 12,
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6
                    }}
                  >
                    <Icon name="info" />
                    <span>{t('Retirement recommended (threshold reached)')}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Helper to open GearManager sheet modal via useUI.
 */
export function openGearManager() {
  useUI.getState().openSheet(close => <GearManager close={close} />)
}
