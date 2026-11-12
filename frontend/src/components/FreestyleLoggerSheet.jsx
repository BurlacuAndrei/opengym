import React, { useState, useEffect, useRef } from 'react'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Button, Segmented, TextArea } from './ui.jsx'
import { useUI } from '../store/useUI.js'
import { useStore } from '../store/useStore.js'
import {
  FREESTYLE_MODALITIES,
  isValidModality,
  formatModality,
  formatTimerClock,
  startFreestyleTimer,
  pauseFreestyleTimer,
  resumeFreestyleTimer,
  getFreestyleTimerElapsedMs,
  finishFreestyleTimer,
  calculateFreestyleLoad,
  logFreestyleSession
} from '../lib/freestyle-session.js'

export default function FreestyleLoggerSheet({
  initialKind = 'hiit',
  close,
  onSave,
  store = useStore
}) {
  const [kind, setKind] = useState(() => (isValidModality(initialKind) ? initialKind : 'hiit'))
  const [status, setStatus] = useState('idle') // 'idle' | 'running' | 'paused' | 'finished'
  const [timerState, setTimerState] = useState(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [rpe, setRpe] = useState(6)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState(null)

  const timerRef = useRef(null)

  // Interval ticker when timer is running
  useEffect(() => {
    if (status === 'running' && timerState) {
      const tick = () => {
        setElapsedMs(getFreestyleTimerElapsedMs(timerState, Date.now()))
      }
      tick()
      const intervalId = setInterval(tick, 250)
      return () => clearInterval(intervalId)
    }
  }, [status, timerState])

  const handleStart = () => {
    setError(null)
    const now = Date.now()
    const state = startFreestyleTimer(kind, now)
    setTimerState(state)
    setStatus('running')
    setElapsedMs(0)
  }

  const handlePause = () => {
    if (status !== 'running' || !timerState) return
    const now = Date.now()
    const paused = pauseFreestyleTimer(timerState, now)
    setTimerState(paused)
    setStatus('paused')
    setElapsedMs(getFreestyleTimerElapsedMs(paused, now))
  }

  const handleResume = () => {
    if (status !== 'paused' || !timerState) return
    const now = Date.now()
    const resumed = resumeFreestyleTimer(timerState, now)
    setTimerState(resumed)
    setStatus('running')
    setElapsedMs(getFreestyleTimerElapsedMs(resumed, now))
  }

  const handleFinish = () => {
    if (!timerState) return
    const now = Date.now()
    const result = finishFreestyleTimer(timerState, { rpe, notes }, now)
    setTimerState(result.timerState)
    setStatus('finished')
    setElapsedMs(result.session.durationMs)
  }

  const handleReset = () => {
    setStatus('idle')
    setTimerState(null)
    setElapsedMs(0)
    setError(null)
  }

  // Live session load calculation
  const currentDurationMs = Math.max(0, elapsedMs)
  const currentLoad = calculateFreestyleLoad({ durationMs: currentDurationMs, rpe })
  const durationMinutes = Math.round((currentDurationMs / 60000) * 10) / 10

  const handleSave = () => {
    setError(null)
    if (currentDurationMs <= 0) {
      setError(t('Duration must be greater than 0'))
      return
    }

    try {
      const saved = logFreestyleSession(
        {
          kind,
          durationMs: currentDurationMs,
          rpe,
          notes,
          startTime: timerState?.startTime ? new Date(timerState.startTime).toISOString() : new Date().toISOString()
        },
        store
      )

      if (typeof onSave === 'function') {
        onSave(saved)
      }

      if (typeof close === 'function') {
        close()
      }
    } catch (err) {
      setError(err?.message || t('Failed to save session'))
    }
  }

  const modalityOptions = FREESTYLE_MODALITIES.map(m => ({
    value: m,
    label: formatModality(m)
  }))

  return (
    <div className="freestyle-logger-sheet" style={{ padding: '4px 0' }}>
      {/* Header */}
      <div className="row between" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>
          {t('Freestyle Session')}
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

      {/* Modality selector */}
      <div style={{ marginBottom: 16 }}>
        <Segmented
          options={modalityOptions}
          value={kind}
          onChange={val => {
            if (status === 'idle') setKind(val)
          }}
        />
      </div>

      {/* Timer display */}
      <div
        className="card"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px 16px',
          marginBottom: 16,
          background: 'var(--card-bg, #1e1e24)',
          borderRadius: 12
        }}
      >
        <div
          className="muted small uppercase font-bold"
          style={{ letterSpacing: '0.08em', marginBottom: 6 }}
        >
          {status === 'running' && t('Recording')}
          {status === 'paused' && t('Paused')}
          {status === 'finished' && t('Completed')}
          {status === 'idle' && t('Ready to start')}
        </div>
        <div
          data-testid="timer-display"
          style={{
            fontSize: '3.2rem',
            fontFamily: 'monospace',
            fontWeight: 700,
            lineHeight: 1.1,
            color: status === 'running' ? 'var(--acc)' : 'inherit',
            marginBottom: 8
          }}
        >
          {formatTimerClock(currentDurationMs)}
        </div>
        <div className="muted small">
          {formatModality(kind)} · {durationMinutes} {t('min')}
        </div>
      </div>

      {/* Flow controls */}
      <div style={{ marginBottom: 16 }}>
        {status === 'idle' && (
          <Button
            variant="primary"
            icon="play"
            style={{ width: '100%', height: 48, fontSize: 16 }}
            onClick={handleStart}
          >
            {t('Start {0}', formatModality(kind))}
          </Button>
        )}

        {status === 'running' && (
          <div className="row" style={{ gap: 10 }}>
            <Button
              variant="plain"
              icon="pause"
              style={{ flex: 1, height: 44 }}
              onClick={handlePause}
            >
              {t('Pause')}
            </Button>
            <Button
              variant="primary"
              icon="check"
              style={{ flex: 1, height: 44 }}
              onClick={handleFinish}
            >
              {t('Finish')}
            </Button>
          </div>
        )}

        {status === 'paused' && (
          <div className="row" style={{ gap: 8 }}>
            <Button
              variant="primary"
              icon="play"
              style={{ flex: 1, height: 44 }}
              onClick={handleResume}
            >
              {t('Resume')}
            </Button>
            <Button
              variant="plain"
              icon="check"
              style={{ flex: 1, height: 44 }}
              onClick={handleFinish}
            >
              {t('Finish')}
            </Button>
            <Button
              variant="plain"
              icon="reset"
              onClick={handleReset}
              aria-label={t('Reset')}
            />
          </div>
        )}

        {status === 'finished' && (
          <div className="row" style={{ gap: 8 }}>
            <Button
              variant="plain"
              icon="reset"
              style={{ flex: 1 }}
              onClick={handleReset}
            >
              {t('Discard / Reset')}
            </Button>
          </div>
        )}
      </div>

      {/* Training Load & Metrics Tile */}
      <div className="tiles" style={{ marginBottom: 16 }}>
        <div className="tile">
          <div className="l">{t('Duration')}</div>
          <div className="v" style={{ fontSize: '1.1rem' }}>
            {durationMinutes} <span style={{ fontSize: '0.8rem' }}>min</span>
          </div>
        </div>
        <div className="tile">
          <div className="l">{t('Effort (RPE)')}</div>
          <div className="v" style={{ fontSize: '1.1rem' }}>
            {rpe}/10
          </div>
        </div>
        <div className="tile">
          <div className="l">{t('sRPE Load')}</div>
          <div className="v" style={{ fontSize: '1.1rem', color: 'var(--acc)' }} data-testid="srpe-load">
            {currentLoad} <span style={{ fontSize: '0.8rem' }}>AU</span>
          </div>
        </div>
      </div>

      {/* RPE Selector */}
      <div style={{ marginBottom: 14 }}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <label className="muted small font-bold">
            {t('Rate of Perceived Exertion (sRPE 1-10)')}
          </label>
          <span className="small font-bold" style={{ color: 'var(--acc)' }}>
            {rpe}/10
          </span>
        </div>
        <div className="chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(val => (
            <button
              key={val}
              type="button"
              className={`chip ${rpe === val ? 'on' : ''}`}
              style={{ minWidth: 32, textAlign: 'center' }}
              onClick={() => setRpe(val)}
              data-testid={`rpe-chip-${val}`}
            >
              {val}
            </button>
          ))}
        </div>
      </div>

      {/* Notes Area */}
      <div style={{ marginBottom: 16 }}>
        <label className="muted small font-bold" style={{ display: 'block', marginBottom: 4 }}>
          {t('Notes (optional)')}
        </label>
        <TextArea
          rows={2}
          placeholder={t('How did the session feel?...')}
          value={notes}
          onChange={e => setNotes(e.target.value)}
          data-testid="freestyle-notes"
        />
      </div>

      {/* Error display */}
      {error && (
        <div className="small" style={{ color: 'var(--red, #f44336)', marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Save Button */}
      <div>
        <Button
          variant="primary"
          style={{ width: '100%', height: 44 }}
          onClick={handleSave}
          disabled={currentDurationMs <= 0}
          data-testid="save-freestyle-btn"
        >
          {t('Save {0} session', formatModality(kind))}
        </Button>
      </div>
    </div>
  )
}

/**
 * Helper to open the FreestyleLoggerSheet in UI sheet container.
 * @param {Object} [opts]
 * @returns {*}
 */
export function openFreestyleLoggerSheet(opts = {}) {
  return useUI.getState().openSheet(close => (
    <FreestyleLoggerSheet close={close} {...opts} />
  ))
}
