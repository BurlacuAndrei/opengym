import React, { useState } from 'react'
import Icon from './Icon.jsx'
import { Button, Segmented, TextField, NumberField } from './ui.jsx'
import {
  STEP_TYPES,
  HR_ZONES,
  createIntervalStep,
  createRepeatStep,
  validateIntervalSteps,
  calculateTotalIntervalTarget,
  moveIntervalStep,
  duplicateIntervalStep,
  formatStepDuration,
  formatStepTarget
} from '../lib/interval-editor.js'
import { isImperial, distanceUnit, speedUnit, paceUnit } from '../lib/cardio-format.js'

/**
 * Step type labels and accent themes.
 */
const STEP_META = {
  warmup: { label: 'Warmup', icon: 'flame', color: 'var(--orange, #ff9f0a)' },
  work: { label: 'Work', icon: 'bolt', color: 'var(--red, #ff453a)' },
  recover: { label: 'Recover', icon: 'heart', color: 'var(--green, #30d158)' },
  cooldown: { label: 'Cooldown', icon: 'clock', color: 'var(--blue, #0a84ff)' },
  repeat: { label: 'Repeat Block', icon: 'timer', color: 'var(--accent, #bf5af2)' }
}

/**
 * Sub-component to edit a single step target (duration or distance + optional targets).
 */
function SingleStepFields({
  step,
  onChange,
  unit = 'km',
  readOnly = false,
  label = null
}) {
  const isImp = isImperial(unit)
  const distUnit = distanceUnit(unit)
  const spdUnit = speedUnit(unit)

  // Current target mode: 'duration' vs 'distance'
  const targetMode = step.distanceM != null && (step.durationMs == null || step.distanceM > 0)
    ? 'distance'
    : 'duration'

  const durationSec = Math.round((step.durationMs || 0) / 1000)
  const durationMin = Math.floor(durationSec / 60)
  const durationRemSec = durationSec % 60

  const handleModeChange = mode => {
    if (readOnly) return
    if (mode === 'duration') {
      onChange({
        ...step,
        durationMs: step.durationMs || 180000,
        distanceM: null
      })
    } else {
      onChange({
        ...step,
        distanceM: step.distanceM || (isImp ? 1609 : 1000),
        durationMs: null
      })
    }
  }

  const handleDurationChange = (minutes, seconds) => {
    if (readOnly) return
    const m = Math.max(0, parseInt(minutes, 10) || 0)
    const s = Math.max(0, Math.min(59, parseInt(seconds, 10) || 0))
    const totalMs = (m * 60 + s) * 1000
    onChange({
      ...step,
      durationMs: totalMs > 0 ? totalMs : 60000
    })
  }

  const handleDistanceChange = val => {
    if (readOnly) return
    const num = Math.max(0, Number(val) || 0)
    const meters = isImp ? Math.round(num * 1609.344) : Math.round(num * 1000)
    onChange({
      ...step,
      distanceM: meters > 0 ? meters : 500
    })
  }

  const handleHrZone = zone => {
    if (readOnly) return
    onChange({
      ...step,
      targetHrZone: step.targetHrZone === zone ? null : zone
    })
  }

  return (
    <div className="interval-single-fields" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {label && (
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--label-2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {label}
        </div>
      )}

      {/* Target mode selection */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Segmented
          options={[
            { value: 'duration', label: 'Duration' },
            { value: 'distance', label: 'Distance' }
          ]}
          value={targetMode}
          onChange={handleModeChange}
          className="interval-mode-seg"
        />

        {targetMode === 'duration' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <input
                type="number"
                min="0"
                max="999"
                disabled={readOnly}
                value={durationMin}
                onChange={e => handleDurationChange(e.target.value, durationRemSec)}
                className="num"
                style={{ width: 55, textAlign: 'center' }}
                aria-label="Minutes"
              />
              <span style={{ fontSize: 12, color: 'var(--label-2)' }}>m</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <input
                type="number"
                min="0"
                max="59"
                disabled={readOnly}
                value={durationRemSec}
                onChange={e => handleDurationChange(durationMin, e.target.value)}
                className="num"
                style={{ width: 50, textAlign: 'center' }}
                aria-label="Seconds"
              />
              <span style={{ fontSize: 12, color: 'var(--label-2)' }}>s</span>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
            <input
              type="number"
              step="0.05"
              min="0"
              disabled={readOnly}
              value={step.distanceM ? (isImp ? (step.distanceM / 1609.344).toFixed(2) : (step.distanceM / 1000).toFixed(2)) : ''}
              onChange={e => handleDistanceChange(e.target.value)}
              className="num"
              style={{ width: 85, textAlign: 'center' }}
              aria-label="Distance"
              placeholder="0.00"
            />
            <span style={{ fontSize: 12, color: 'var(--label-2)' }}>{distUnit}</span>
          </div>
        )}
      </div>

      {/* Optional targets (HR Zone, Target Pace, Target Speed) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, fontSize: 13 }}>
        {/* Heart Rate Zones */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--label-3)' }}>HR Zone:</span>
          <div style={{ display: 'flex', gap: 3 }}>
            {HR_ZONES.map(z => {
              const active = step.targetHrZone === z
              return (
                <button
                  key={z}
                  type="button"
                  disabled={readOnly}
                  onClick={() => handleHrZone(z)}
                  aria-label={`Target HR Zone ${z}`}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 6,
                    border: 'none',
                    fontSize: 12,
                    fontWeight: active ? 700 : 500,
                    cursor: readOnly ? 'default' : 'pointer',
                    background: active ? 'var(--blue, #0a84ff)' : 'var(--surface-3, #3a3a3c)',
                    color: active ? '#fff' : 'var(--label-2)'
                  }}
                >
                  Z{z}
                </button>
              )
            })}
          </div>
        </div>

        {/* Target Pace */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--label-3)' }}>Pace:</span>
          <input
            type="text"
            disabled={readOnly}
            placeholder="e.g. 5:00"
            value={step.targetPace || ''}
            onChange={e => onChange({ ...step, targetPace: e.target.value || null })}
            className="field"
            style={{ width: 75, padding: '3px 6px', fontSize: 12 }}
            aria-label="Target Pace"
          />
        </div>

        {/* Target Speed */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--label-3)' }}>Speed:</span>
          <input
            type="number"
            step="0.5"
            min="0"
            disabled={readOnly}
            placeholder="0.0"
            value={step.targetSpeed || ''}
            onChange={e => onChange({ ...step, targetSpeed: e.target.value ? Number(e.target.value) : null })}
            className="num"
            style={{ width: 60, padding: '3px 6px', fontSize: 12 }}
            aria-label="Target Speed"
          />
          <span style={{ fontSize: 11, color: 'var(--label-3)' }}>{spdUnit}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Main IntervalEditor component.
 *
 * @param {Object} props
 * @param {Array} [props.steps=[]] - Current list of interval steps
 * @param {Function} props.onChange - Callback when steps are modified
 * @param {string} [props.unit='km'] - Distance unit ('km' or 'miles')
 * @param {boolean} [props.readOnly=false] - Whether editing is disabled
 * @param {string} [props.className=''] - Additional CSS classes
 */
export default function IntervalEditor({
  steps = [],
  onChange,
  unit = 'km',
  readOnly = false,
  className = ''
}) {
  const safeSteps = Array.isArray(steps) ? steps : []
  const totals = calculateTotalIntervalTarget(safeSteps)
  const validation = validateIntervalSteps(safeSteps)

  const handleStepChange = (idx, nextStep) => {
    if (readOnly || !onChange) return
    const next = [...safeSteps]
    next[idx] = nextStep
    onChange(next)
  }

  const handleRemoveStep = idx => {
    if (readOnly || !onChange) return
    const next = safeSteps.filter((_, i) => i !== idx)
    onChange(next)
  }

  const handleDuplicateStep = idx => {
    if (readOnly || !onChange) return
    onChange(duplicateIntervalStep(safeSteps, idx))
  }

  const handleMoveUp = idx => {
    if (readOnly || !onChange || idx <= 0) return
    onChange(moveIntervalStep(safeSteps, idx, idx - 1))
  }

  const handleMoveDown = idx => {
    if (readOnly || !onChange || idx >= safeSteps.length - 1) return
    onChange(moveIntervalStep(safeSteps, idx, idx + 1))
  }

  const handleAddStep = type => {
    if (readOnly || !onChange) return
    if (type === 'repeat') {
      onChange([...safeSteps, createRepeatStep(4)])
    } else {
      onChange([...safeSteps, createIntervalStep(type)])
    }
  }

  const handleRepeatCountChange = (idx, count) => {
    if (readOnly || !onChange) return
    const step = safeSteps[idx]
    if (!step || step.type !== 'repeat') return
    const safeCount = Math.max(1, Math.floor(Number(count) || 1))
    handleStepChange(idx, { ...step, count: safeCount })
  }

  return (
    <div
      className={`interval-editor ${className}`.trim()}
      data-testid="interval-editor"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '12px 0'
      }}
    >
      {/* Overview & Totals Header */}
      <div
        className="interval-summary-bar"
        data-testid="interval-summary-bar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
          padding: '10px 14px',
          background: 'var(--surface, #1c1c1e)',
          borderRadius: 12,
          border: '1px solid var(--sep, rgba(84,84,88,.34))'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="timer" size={16} />
            <span style={{ fontSize: 13, color: 'var(--label-2)' }}>Duration:</span>
            <strong style={{ fontSize: 14 }}>{formatStepDuration(totals.totalDurationMs) || '0m'}</strong>
          </div>

          {totals.totalDistanceM > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="figureRun" size={16} />
              <span style={{ fontSize: 13, color: 'var(--label-2)' }}>Distance:</span>
              <strong style={{ fontSize: 14 }}>
                {isImperial(unit)
                  ? `${(totals.totalDistanceM / 1609.344).toFixed(2)} mi`
                  : `${(totals.totalDistanceM / 1000).toFixed(2)} km`}
              </strong>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--label-2)' }}>Steps:</span>
            <strong style={{ fontSize: 14 }}>{totals.stepCount}</strong>
          </div>
        </div>

        {!validation.valid && safeSteps.length > 0 && (
          <div
            data-testid="interval-validation-warning"
            style={{
              fontSize: 12,
              color: 'var(--orange, #ff9f0a)',
              display: 'flex',
              alignItems: 'center',
              gap: 4
            }}
          >
            <Icon name="info" size={14} />
            <span>{validation.errors[0]}</span>
          </div>
        )}
      </div>

      {/* Steps List */}
      <div
        className="interval-steps-list"
        data-testid="interval-steps-list"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {safeSteps.length === 0 ? (
          <div
            data-testid="interval-empty-state"
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'var(--label-3)',
              background: 'var(--surface, #1c1c1e)',
              borderRadius: 12,
              border: '1px dashed var(--sep, rgba(84,84,88,.4))'
            }}
          >
            No interval steps configured yet. Use the buttons below to build your structured workout.
          </div>
        ) : (
          safeSteps.map((step, idx) => {
            const meta = STEP_META[step.type] || STEP_META.work
            const isRepeat = step.type === 'repeat'

            return (
              <div
                key={step.id || idx}
                data-testid={`interval-step-${idx}`}
                className="interval-step-card"
                style={{
                  background: 'var(--surface, #1c1c1e)',
                  borderRadius: 12,
                  padding: 14,
                  border: `1px solid ${isRepeat ? 'var(--accent, #bf5af2)' : 'var(--sep, rgba(84,84,88,.34))'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12
                }}
              >
                {/* Step Card Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        background: 'var(--surface-3, #3a3a3c)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        fontWeight: 600
                      }}
                    >
                      {idx + 1}
                    </span>

                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 600,
                        background: meta.color + '22',
                        color: meta.color,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4
                      }}
                    >
                      <Icon name={meta.icon} size={14} />
                      {meta.label}
                    </span>
                  </div>

                  {/* Step Action Buttons */}
                  {!readOnly && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => handleMoveUp(idx)}
                        aria-label="Move step up"
                        className="btn plain"
                        style={{ padding: 4, opacity: idx === 0 ? 0.3 : 1 }}
                      >
                        <Icon name="arrowUp" size={16} />
                      </button>
                      <button
                        type="button"
                        disabled={idx === safeSteps.length - 1}
                        onClick={() => handleMoveDown(idx)}
                        aria-label="Move step down"
                        className="btn plain"
                        style={{ padding: 4, opacity: idx === safeSteps.length - 1 ? 0.3 : 1 }}
                      >
                        <Icon name="arrowDown" size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDuplicateStep(idx)}
                        aria-label="Duplicate step"
                        className="btn plain"
                        style={{ padding: 4 }}
                      >
                        <Icon name="clipboard" size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveStep(idx)}
                        aria-label="Remove step"
                        className="btn plain"
                        style={{ padding: 4, color: 'var(--red, #ff453a)' }}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Step Body */}
                {isRepeat ? (
                  /* Nested Repeat Block */
                  <div
                    data-testid={`repeat-block-${idx}`}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      paddingLeft: 8,
                      borderLeft: '2px solid var(--accent, #bf5af2)'
                    }}
                  >
                    {/* Repeat Count Header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--label)' }}>
                        Repeat Count:
                      </span>
                      <input
                        type="number"
                        min="1"
                        max="99"
                        disabled={readOnly}
                        value={step.count || 1}
                        onChange={e => handleRepeatCountChange(idx, e.target.value)}
                        className="num"
                        style={{ width: 60, textAlign: 'center' }}
                        aria-label="Repeat Count"
                      />
                      <span style={{ fontSize: 12, color: 'var(--label-2)' }}>times</span>
                    </div>

                    {/* Nested Work Step */}
                    <div
                      data-testid={`repeat-work-step-${idx}`}
                      style={{
                        background: 'var(--surface-2, #2c2c2e)',
                        borderRadius: 8,
                        padding: 10
                      }}
                    >
                      <SingleStepFields
                        label="Work Interval"
                        step={step.workStep || createIntervalStep('work')}
                        unit={unit}
                        readOnly={readOnly}
                        onChange={nextWork => handleStepChange(idx, { ...step, workStep: nextWork })}
                      />
                    </div>

                    {/* Nested Recover Step */}
                    <div
                      data-testid={`repeat-recover-step-${idx}`}
                      style={{
                        background: 'var(--surface-2, #2c2c2e)',
                        borderRadius: 8,
                        padding: 10
                      }}
                    >
                      <SingleStepFields
                        label="Recover Interval"
                        step={step.recoverStep || createIntervalStep('recover')}
                        unit={unit}
                        readOnly={readOnly}
                        onChange={nextRec => handleStepChange(idx, { ...step, recoverStep: nextRec })}
                      />
                    </div>
                  </div>
                ) : (
                  /* Single Step (warmup, work, recover, cooldown) */
                  <SingleStepFields
                    step={step}
                    unit={unit}
                    readOnly={readOnly}
                    onChange={nextStep => handleStepChange(idx, nextStep)}
                  />
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Add Step Controls Toolbar */}
      {!readOnly && (
        <div
          className="interval-add-controls"
          data-testid="interval-add-controls"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            paddingTop: 4
          }}
        >
          <Button
            variant="secondary"
            size="sm"
            icon="plus"
            onClick={() => handleAddStep('warmup')}
          >
            Warmup
          </Button>

          <Button
            variant="secondary"
            size="sm"
            icon="plus"
            onClick={() => handleAddStep('work')}
          >
            Work
          </Button>

          <Button
            variant="secondary"
            size="sm"
            icon="plus"
            onClick={() => handleAddStep('recover')}
          >
            Recover
          </Button>

          <Button
            variant="secondary"
            size="sm"
            icon="timer"
            onClick={() => handleAddStep('repeat')}
          >
            Repeat Block
          </Button>

          <Button
            variant="secondary"
            size="sm"
            icon="plus"
            onClick={() => handleAddStep('cooldown')}
          >
            Cooldown
          </Button>
        </div>
      )}
    </div>
  )
}
