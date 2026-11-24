import React, { useState, useEffect } from 'react'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Button, Segmented, TextArea, NumberField } from './ui.jsx'
import { getActiveGear, isGearRetired, resolveDefaultGearForSport } from '../lib/gear.js'
import { useUI } from '../store/useUI.js'
import {
  useStore,
  CARDIO_TYPES,
  validateCardioActivity,
  logCardioActivity,
  updateCardioActivity,
  deleteCardioActivity
} from '../store/useStore.js'
import {
  isImperial,
  distanceUnit,
  elevationUnit,
  kmToMeters,
  metersToKm,
  milesToMeters,
  metersToMiles,
  feetToMeters,
  metersToFeet,
  paceFromSeconds,
  speedFromSeconds,
  fmtPace,
  formatSpeed
} from '../lib/cardio-format.js'

function toDatetimeLocal(isoOrMs) {
  if (!isoOrMs) {
    const d = new Date()
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
    return d.toISOString().slice(0, 16)
  }
  const d = new Date(isoOrMs)
  if (isNaN(d.getTime())) return ''
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

function fromDatetimeLocal(val) {
  if (!val) return new Date().toISOString()
  const d = new Date(val)
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

export default function ManualCardioSheet({
  activity,
  unit: propUnit,
  onSave,
  onDelete,
  close
}) {
  const hookS = useStore ? useStore(s => s.S) : null
  const S = useStore?.getState?.()?.S || hookS || {}
  const rawUnit = propUnit || S.unit || 'kg'
  const unit = (rawUnit === 'lb' || rawUnit === 'lbs' || rawUnit === 'imperial') ? 'lbs' : 'kg'
  const isImp = isImperial(unit)
  const dUnit = distanceUnit(unit)
  const eUnit = elevationUnit(unit)

  const toast = useUI?.getState?.()?.toast || (() => {})

  const isEdit = Boolean(activity && activity.id)
  const initialType =
    activity?.type && CARDIO_TYPES.includes(activity.type) ? activity.type : 'run'
  const allGear = Array.isArray(S.gear) ? S.gear : []
  const activeGear = getActiveGear(allGear)

  const [type, setType] = useState(initialType)
  const [startTime, setStartTime] = useState(() =>
    toDatetimeLocal(activity?.startTime)
  )

  const [durMin, setDurMin] = useState(() => {
    if (!activity?.durationMs) return ''
    return Math.floor(activity.durationMs / 60000)
  })
  const [durSec, setDurSec] = useState(() => {
    if (!activity?.durationMs) return ''
    return Math.round((activity.durationMs % 60000) / 1000)
  })

  const [dist, setDist] = useState(() => {
    if (activity?.distanceM == null || activity.distanceM <= 0) return ''
    const val = isImp ? metersToMiles(activity.distanceM) : metersToKm(activity.distanceM)
    return Math.round(val * 100) / 100
  })

  const [elevation, setElevation] = useState(() => {
    if (activity?.elevationGainM == null || activity.elevationGainM <= 0) return ''
    const val = isImp ? metersToFeet(activity.elevationGainM) : activity.elevationGainM
    return Math.round(val)
  })

  const [calories, setCalories] = useState(() =>
    activity?.calories != null ? activity.calories : ''
  )
  const [rpe, setRpe] = useState(() =>
    activity?.rpe != null ? activity.rpe : null
  )
  const [gearTouched, setGearTouched] = useState(false)
  const [gearId, setGearId] = useState(() => {
    const raw = typeof activity?.gearId === 'string' ? activity.gearId.trim() : ''
    if (raw) {
      const byId = allGear.find(g => g && g.id === raw)
      if (byId) return byId.id
      const lower = raw.toLowerCase()
      const byName = allGear.find(
        g => g && typeof g.name === 'string' && g.name.trim().toLowerCase() === lower
      )
      if (byName && byName.id) return byName.id
      return raw
    }
    return isEdit ? '' : resolveDefaultGearForSport(allGear, initialType)
  })
  const [notes, setNotes] = useState(() => activity?.notes || '')
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isEdit && !gearTouched) {
      setGearId(resolveDefaultGearForSport(S.gear, type))
    }
  }, [type, gearTouched, isEdit, S.gear])

  const hasSelectedActive = Boolean(gearId && activeGear.some(g => g.id === gearId))
  const fallbackGearItem =
    gearId && !hasSelectedActive ? allGear.find(g => g && g.id === gearId) : null
  const fallbackGearLabel = fallbackGearItem
    ? `${fallbackGearItem.name || t('Gear')}${isGearRetired(fallbackGearItem) ? ` (${t('Retired')})` : ''}`
    : gearId

  // Live metrics calculation
  const durSecTotal = (Number(durMin) || 0) * 60 + (Number(durSec) || 0)
  const durMsTotal = durSecTotal * 1000
  const distVal = Number(dist) || 0
  const distMTotal = distVal > 0 ? (isImp ? milesToMeters(distVal) : kmToMeters(distVal)) : 0

  const livePaceMin = durSecTotal > 0 && distMTotal > 0
    ? paceFromSeconds(durSecTotal, distMTotal, unit)
    : null
  const liveSpeed = durSecTotal > 0 && distMTotal > 0
    ? speedFromSeconds(durSecTotal, distMTotal, unit)
    : null

  const handleSave = () => {
    const elevVal = Number(elevation) || 0
    const elevMTotal = elevVal > 0 ? (isImp ? feetToMeters(elevVal) : elevVal) : 0

    const record = {
      type,
      startTime: fromDatetimeLocal(startTime),
      durationMs: durMsTotal,
      distanceM: distMTotal,
      elevationGainM: elevMTotal,
      calories: calories !== '' && calories != null ? Number(calories) : null,
      rpe: rpe !== '' && rpe != null ? Number(rpe) : null,
      notes: notes ? notes.trim() : '',
      gearId: gearId ? gearId.trim() : null
    }

    const { valid, errors } = validateCardioActivity(record)
    if (!valid) {
      setError(errors[0])
      toast(errors[0])
      return
    }

    let saved
    if (isEdit) {
      saved = updateCardioActivity(activity.id, record)
      toast(t('Cardio activity updated'))
    } else {
      saved = logCardioActivity(record)
      toast(t('Cardio activity saved'))
    }

    onSave?.(saved)
    close?.()
  }

  const handleDelete = () => {
    if (!activity?.id) return
    const deleted = deleteCardioActivity(activity.id)
    toast(t('Cardio activity deleted'))
    onDelete?.(deleted)
    close?.()
  }

  return (
    <div className="manual-cardio-sheet" style={{ padding: '4px 0' }}>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>
          {isEdit ? t('Edit cardio') : t('Log cardio')}
        </h3>
        {close && (
          <button
            type="button"
            className="iconbtn"
            onClick={close}
            aria-label={t('Close')}
          >
            <Icon name="xmark" />
          </button>
        )}
      </div>

      <div style={{ marginBottom: 14 }}>
        <Segmented
          options={[
            { value: 'run', label: t('Run') },
            { value: 'ride', label: t('Ride') },
            { value: 'hike', label: t('Hike') },
            { value: 'walk', label: t('Walk') }
          ]}
          value={type}
          onChange={setType}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
          {t('Date & Time')}
        </label>
        <input
          type="datetime-local"
          className="field num"
          value={startTime}
          onChange={e => setStartTime(e.target.value)}
        />
      </div>

      <div className="row" style={{ gap: 10, marginBottom: 12, alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
            {t('Duration (min)')}
          </label>
          <NumberField
            className="field"
            placeholder="0"
            value={durMin}
            onChange={setDurMin}
            decimal={false}
          />
        </div>
        <div style={{ flex: '0 0 76px', minWidth: 0 }}>
          <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
            {t('Sec')}
          </label>
          <NumberField
            className="field"
            placeholder="0"
            value={durSec}
            onChange={setDurSec}
            decimal={false}
          />
        </div>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
            {t('Distance ({0})', dUnit)}
          </label>
          <NumberField
            className="field"
            placeholder="0.00"
            value={dist}
            onChange={setDist}
            decimal={true}
            nullable={true}
          />
        </div>
      </div>

      {(livePaceMin || liveSpeed) && (
        <div className="tiles" style={{ marginBottom: 12 }}>
          {livePaceMin && (
            <div className="tile">
              <div className="l">{t('Avg Pace')}</div>
              <div className="v" style={{ fontSize: '1.05rem' }}>
                {fmtPace(livePaceMin, unit)}
              </div>
            </div>
          )}
          {liveSpeed && (
            <div className="tile">
              <div className="l">{t('Avg Speed')}</div>
              <div className="v" style={{ fontSize: '1.05rem' }}>
                {formatSpeed(liveSpeed, unit)}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 10, marginBottom: 12, alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
            {t('Elevation Gain ({0})', eUnit)}
          </label>
          <NumberField
            className="field"
            placeholder="0"
            value={elevation}
            onChange={setElevation}
            decimal={false}
            nullable={true}
          />
        </div>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
            {t('Calories (kcal)')}
          </label>
          <NumberField
            className="field"
            placeholder="0"
            value={calories}
            onChange={setCalories}
            decimal={false}
            nullable={true}
          />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div className="row between" style={{ marginBottom: 4 }}>
          <label className="muted small">{t('Perceived Exertion (RPE 1–10)')}</label>
          {rpe && (
            <span className="small font-bold" style={{ color: 'var(--acc)' }}>
              {rpe}/10
            </span>
          )}
        </div>
        <div className="chips" style={{ flexWrap: 'wrap', gap: 6 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
            <button
              key={n}
              type="button"
              className={`chip ${rpe === n ? 'on' : ''}`}
              onClick={() => setRpe(rpe === n ? null : n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label
          htmlFor="manual-cardio-gear"
          className="muted small"
          style={{ display: 'block', marginBottom: 4 }}
        >
          {t('Active Gear')}
        </label>
        <select
          id="manual-cardio-gear"
          data-testid="manual-gear-selector"
          className="field"
          value={gearId}
          disabled={activeGear.length === 0 && !gearId}
          onChange={e => {
            setGearTouched(true)
            setGearId(e.target.value)
          }}
        >
          <option value="">{t('No gear selected')}</option>
          {gearId && !hasSelectedActive && (
            <option value={gearId}>{fallbackGearLabel}</option>
          )}
          {activeGear.map(g => (
            <option key={g.id} value={g.id}>
              {g.name || t('Gear')}{g.isDefault ? ` (${t('Default')})` : ''}
            </option>
          ))}
        </select>
        {activeGear.length === 0 && !gearId && (
          <div className="muted small" style={{ marginTop: 4 }}>
            {t('No active gear yet. Track mileage on your running shoes and bikes.')}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 14 }}>
        <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
          {t('Notes')}
        </label>
        <TextArea
          rows={2}
          placeholder={t('Add notes...')}
          value={notes}
          onChange={e => setNotes(e.target.value)}
        />
      </div>

      {error && (
        <div className="small" style={{ color: 'var(--red)', marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        <Button variant="primary" style={{ flex: 1 }} onClick={handleSave}>
          {isEdit ? t('Update activity') : t('Save activity')}
        </Button>
        {isEdit && (
          <Button
            variant="danger"
            onClick={handleDelete}
            aria-label={t('Delete')}
          >
            <Icon name="trash" />
          </Button>
        )}
      </div>
    </div>
  )
}

export function openManualCardioSheet(activity, opts = {}) {
  return useUI.getState().openSheet(close => (
    <ManualCardioSheet activity={activity} close={close} {...opts} />
  ))
}
