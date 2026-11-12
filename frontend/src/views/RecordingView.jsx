import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import RouteCanvas from '../components/RouteCanvas.jsx'
import { t } from '../lib/i18n.js'
import { useWakeLock } from '../lib/wakelock.js'
import {
  RECORDING_STATUS,
  getCardioRecorder,
  startRecording as defaultStartRecording,
  pauseRecording as defaultPauseRecording,
  resumeRecording as defaultResumeRecording,
  finishRecording as defaultFinishRecording,
  discardRecording as defaultDiscardRecording,
} from '../lib/cardio-recording.js'
import {
  fmtDist,
  formatPace,
  formatSpeed,
  convertDistance,
  convertSpeed,
  distanceUnit,
  speedUnit,
  formatElevation,
} from '../lib/cardio-format.js'

/**
 * Calculates GPS accuracy rating and display metadata.
 *
 * @param {number|null} accuracy - Accuracy in meters
 * @returns {{ level: 'good'|'fair'|'poor'|'searching', label: string, color: string, bg: string }}
 */
export function getGpsAccuracyStatus(accuracy) {
  if (accuracy == null || isNaN(Number(accuracy))) {
    return {
      level: 'searching',
      label: t('Acquiring GPS…'),
      color: 'var(--muted, #94a3b8)',
      bg: 'var(--surface-2, rgba(148, 163, 184, 0.15))',
    }
  }

  const acc = Number(accuracy)
  if (acc <= 10) {
    return {
      level: 'good',
      label: `GPS ±${Math.round(acc)}m`,
      color: '#10b981',
      bg: 'rgba(16, 185, 129, 0.15)',
    }
  }

  if (acc <= 25) {
    return {
      level: 'fair',
      label: `GPS ±${Math.round(acc)}m`,
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.15)',
    }
  }

  return {
    level: 'poor',
    label: `GPS ±${Math.round(acc)}m`,
    color: '#ef4444',
    bg: 'rgba(239, 68, 68, 0.15)',
  }
}

/**
 * Formats duration milliseconds into "m:ss" or "h:mm:ss" clock display.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDurationClock(ms) {
  if (!ms || isNaN(ms) || ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Android Live Recording View (Issue #62)
 *
 * Features:
 * - GPS accuracy badge (good <10m, fair <25m, poor >25m, searching)
 * - Large metric display (Distance hero metric, Duration, Pace/Speed, Elevation, Calories)
 * - RouteCanvas breadcrumb path drawing
 * - Single-tap Pause & Resume
 * - Long-press Finish button with progress indicator
 * - Finished session summary card with normalized route
 */
export default function RecordingView({
  recorder = null,
  onFinish = null,
  onDiscard = null,
  holdThresholdMs = 1200,
  initialActivityType = 'run',
}) {
  let navigate = () => {}
  try {
    navigate = useNavigate()
  } catch {
    // Router context optional for testing/embedding
  }
  const S = useStore(s => s.S)
  const unit = S?.unit || 'kg'

  // Resolve recorder instance
  const rec = recorder || getCardioRecorder()

  // Component state
  const [recState, setRecState] = useState(() => rec.getState())
  const [liveStats, setLiveStats] = useState(() => rec.getLiveStats())
  const [points, setPoints] = useState(() => (rec.points ? [...rec.points] : []))
  const [selectedType, setSelectedType] = useState(
    rec.activityType || initialActivityType || 'run'
  )
  const [finalizedActivity, setFinalizedActivity] = useState(null)
  const [isFinishing, setIsFinishing] = useState(false)

  // Long press finish state
  const [holdProgress, setHoldProgress] = useState(0)
  const holdTimerRef = useRef(null)
  const holdStartRef = useRef(null)

  // Wake lock keeps the display awake while actively recording
  useWakeLock(recState?.status === RECORDING_STATUS.RECORDING)

  // Subscribe to recorder state changes
  useEffect(() => {
    const syncState = state => {
      setRecState({ ...state })
      setLiveStats({ ...state.liveStats })
      setPoints(rec.points ? [...rec.points] : [])
    }

    // Initial sync
    syncState(rec.getState())

    const unsubscribe = rec.subscribe(syncState)
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [rec])

  // Periodic clock update for smooth timer display while recording
  useEffect(() => {
    if (recState?.status !== RECORDING_STATUS.RECORDING) return
    const interval = setInterval(() => {
      // Re-read liveStats or trigger re-render
      setLiveStats({ ...rec.getLiveStats() })
    }, 1000)
    return () => clearInterval(interval)
  }, [rec, recState?.status])

  // Clean up any ongoing hold timer on unmount
  useEffect(() => {
    return () => {
      if (holdTimerRef.current) {
        clearInterval(holdTimerRef.current)
        holdTimerRef.current = null
      }
    }
  }, [])

  // Activity type and status derived values
  const activityType = recState?.activityType || selectedType || 'run'
  const isRide = activityType === 'ride'
  const isRecording = recState?.status === RECORDING_STATUS.RECORDING
  const isPaused = recState?.status === RECORDING_STATUS.PAUSED
  const isIdle = recState?.status === RECORDING_STATUS.IDLE && !finalizedActivity

  // Current GPS accuracy
  const currentAccuracy =
    recState?.accuracy ?? (points.length ? points[points.length - 1]?.accuracy : null)
  const gpsStatus = getGpsAccuracyStatus(currentAccuracy)

  // Metric displays
  const distanceM = liveStats?.distanceM || 0
  const distConverted = convertDistance(distanceM, unit)
  const heroDistance = distConverted > 0 ? distConverted.toFixed(2) : '0.00'
  const distUnitLabel = distanceUnit(unit)

  const durationMs = liveStats?.movingTimeMs || liveStats?.elapsedTimeMs || 0
  const durationClock = formatDurationClock(durationMs)

  // Pace or speed display
  let rateDisplay = '--'
  if (isRide) {
    if (liveStats?.avgSpeed > 0) {
      const speedKmh = liveStats.avgSpeed * 3.6
      const spd = convertSpeed(speedKmh, unit)
      rateDisplay = `${spd.toFixed(1)} ${speedUnit(unit)}`
    }
  } else {
    if (liveStats?.avgPace > 0) {
      rateDisplay = formatPace(liveStats.avgPace, unit)
    }
  }

  // Elevation and calories
  const elevationDisplay =
    liveStats?.elevationGainM > 0
      ? formatElevation(liveStats.elevationGainM, unit)
      : `0 ${unit === 'lbs' ? 'ft' : 'm'}`
  const caloriesDisplay = `${liveStats?.calories || 0} kcal`

  // Action handlers
  const handleStart = async () => {
    await (rec.startRecording ? rec.startRecording({ type: selectedType }) : defaultStartRecording({ type: selectedType }))
  }

  const handlePause = () => {
    if (rec.pauseRecording) rec.pauseRecording()
    else defaultPauseRecording()
  }

  const handleResume = () => {
    if (rec.resumeRecording) rec.resumeRecording()
    else defaultResumeRecording()
  }

  const executeFinish = useCallback(async () => {
    if (isFinishing) return
    setIsFinishing(true)
    try {
      const activity = rec.finishRecording
        ? await rec.finishRecording()
        : await defaultFinishRecording()
      setFinalizedActivity(activity)
    } catch (err) {
      console.error('Failed to finish recording:', err)
    } finally {
      setIsFinishing(false)
      setHoldProgress(0)
    }
  }, [rec, isFinishing])

  const handleDiscard = async () => {
    const confirmed =
      typeof window === 'undefined' || !window.confirm
        ? true
        : window.confirm(t('Discard this recording? It will not be saved.'))
    if (!confirmed) return

    if (rec.discardRecording) await rec.discardRecording()
    else await defaultDiscardRecording()

    if (onDiscard) onDiscard()
    else navigate('/home')
  }

  const handleDone = () => {
    if (onFinish && finalizedActivity) {
      onFinish(finalizedActivity)
    } else {
      navigate('/home')
    }
  }

  // Long-press hold handler
  const startHold = e => {
    if (isFinishing) return
    if (holdTimerRef.current) return

    holdStartRef.current = Date.now()
    setHoldProgress(0)

    // Interval checks elapsed hold time and updates progress
    const checkInterval = 30
    holdTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - (holdStartRef.current || Date.now())
      const pct = Math.min(100, (elapsed / holdThresholdMs) * 100)
      setHoldProgress(pct)

      if (elapsed >= holdThresholdMs) {
        clearInterval(holdTimerRef.current)
        holdTimerRef.current = null
        setHoldProgress(100)
        executeFinish()
      }
    }, checkInterval)
  }

  const cancelHold = () => {
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current)
      holdTimerRef.current = null
    }
    holdStartRef.current = null
    setHoldProgress(0)
  }

  // ---------------------------------------------------------------------------
  // View 1: Summary Screen (Activity finished)
  // ---------------------------------------------------------------------------
  if (finalizedActivity) {
    const summaryStats = finalizedActivity.summary || finalizedActivity.liveStats || liveStats
    const summaryDistance = fmtDist(finalizedActivity.distanceM || summaryStats.distanceM || 0, unit)
    const summaryDuration = formatDurationClock(finalizedActivity.durationMs || summaryStats.movingTimeMs || 0)
    const summaryRate = finalizedActivity.avgPaceSecKm
      ? formatPace(finalizedActivity.avgPaceSecKm / 60, unit)
      : finalizedActivity.avgSpeedKmh
      ? formatSpeed(finalizedActivity.avgSpeedKmh, unit)
      : rateDisplay

    return (
      <div className="narrow recording-summary-view" data-testid="recording-summary">
        <div className="hdr">
          <div>
            <h1>{t('Cardio Finished')}</h1>
            <div className="sub" style={{ textTransform: 'capitalize' }}>
              {t('{0} summary', finalizedActivity.type || activityType)}
            </div>
          </div>
        </div>

        {/* Route canvas */}
        <div
          className="card"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: 12,
            background: 'var(--surface-1)',
          }}
        >
          <RouteCanvas
            points={finalizedActivity.points || points}
            width={340}
            height={200}
            strokeColor="var(--acc, #3b82f6)"
            startColor="#22c55e"
            endColor="#ef4444"
          />
          <div className="dim small" style={{ marginTop: 8 }}>
            {(finalizedActivity.points || points).length} {t('track points')}
          </div>
        </div>

        {/* Primary summary statistics */}
        <div
          className="metrics-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 12,
            marginTop: 12,
          }}
        >
          <div className="card" style={{ padding: 14 }}>
            <div className="muted small">{t('Distance')}</div>
            <div className="big" data-testid="summary-distance">
              {summaryDistance}
            </div>
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="muted small">{t('Duration')}</div>
            <div className="big" data-testid="summary-duration">
              {summaryDuration}
            </div>
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="muted small">{isRide ? t('Avg Speed') : t('Avg Pace')}</div>
            <div className="big" data-testid="summary-rate">
              {summaryRate}
            </div>
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="muted small">{t('Elevation Gain')}</div>
            <div className="big" data-testid="summary-elevation">
              {formatElevation(summaryStats.elevationGainM || 0, unit)}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <Button
            variant="primary"
            data-testid="summary-done-btn"
            style={{ width: '100%', height: 50, fontSize: 16 }}
            onClick={handleDone}
          >
            {t('Done')}
          </Button>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // View 2: Idle Screen (Start Recording Chooser)
  // ---------------------------------------------------------------------------
  if (isIdle) {
    const activityTypes = ['run', 'ride', 'walk', 'hike']
    return (
      <div className="narrow recording-idle-view" data-testid="recording-idle">
        <div className="hdr">
          <div>
            <h1>{t('Record Cardio')}</h1>
            <div className="sub">{t('GPS-tracked workout')}</div>
          </div>
        </div>

        <div className="card">
          <h2 style={{ margin: '0 0 12px 0' }}>{t('Select Activity')}</h2>
          <div
            className="row"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 10,
              marginBottom: 16,
            }}
          >
            {activityTypes.map(type => (
              <button
                key={type}
                type="button"
                className={`item ${selectedType === type ? 'selected' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: 12,
                  borderRadius: 10,
                  border: selectedType === type ? '2px solid var(--acc)' : '1px solid var(--border)',
                  background: selectedType === type ? 'var(--surface-2)' : 'var(--surface-1)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onClick={() => setSelectedType(type)}
              >
                <Icon name={type === 'ride' ? 'bike' : 'figureRun'} />
                <span style={{ textTransform: 'capitalize', fontWeight: 600 }}>{t(type)}</span>
              </button>
            ))}
          </div>

          <Button
            variant="primary"
            icon="play"
            data-testid="start-recording-btn"
            style={{ width: '100%', height: 52, fontSize: 16 }}
            onClick={handleStart}
          >
            {t('Start {0}', selectedType)}
          </Button>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // View 3: Live Recording Screen (Active or Paused)
  // ---------------------------------------------------------------------------
  return (
    <div className="narrow recording-live-view" data-testid="recording-live-screen">
      {/* Top Header: Activity & Status + GPS Accuracy Badge */}
      <div
        className="recording-header row between"
        style={{ alignItems: 'center', marginBottom: 14 }}
      >
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span
            className="lrow-i"
            style={{
              background: isPaused ? 'var(--yellow, #f59e0b)' : 'var(--acc, #3b82f6)',
              color: '#fff',
              width: 36,
              height: 36,
              borderRadius: 9,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name={isRide ? 'bike' : 'figureRun'} />
          </span>
          <div>
            <div
              className="lbl2"
              data-testid="recording-status-badge"
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: isPaused ? 'var(--yellow, #f59e0b)' : 'var(--acc, #3b82f6)',
                letterSpacing: '0.04em',
              }}
            >
              {isPaused ? t('PAUSED') : t('RECORDING')}
            </div>
            <div
              className="ttl"
              data-testid="activity-type-label"
              style={{ textTransform: 'capitalize', fontSize: 16, fontWeight: 700 }}
            >
              {t(activityType)}
            </div>
          </div>
        </div>

        {/* GPS Accuracy Badge */}
        <div
          className="accuracy-badge"
          data-testid="accuracy-badge"
          data-level={gpsStatus.level}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 11px',
            borderRadius: 20,
            fontSize: 12,
            fontWeight: 600,
            background: gpsStatus.bg,
            color: gpsStatus.color,
            border: `1px solid ${gpsStatus.color}40`,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: gpsStatus.color,
              display: 'inline-block',
            }}
          />
          <span data-testid="accuracy-label">{gpsStatus.label}</span>
        </div>
      </div>

      {/* Large Hero Metric: Primary Distance */}
      <div
        className="hero-metric-card card"
        style={{
          textAlign: 'center',
          padding: '20px 16px',
          marginBottom: 12,
          background: 'var(--surface-1)',
        }}
      >
        <div
          className="muted small"
          style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}
        >
          {t('Distance')}
        </div>
        <div
          data-testid="hero-distance-value"
          style={{
            fontSize: '3.6rem',
            fontWeight: 800,
            lineHeight: 1.1,
            letterSpacing: '-0.03em',
            fontVariantNumeric: 'tabular-nums',
            margin: '4px 0',
          }}
        >
          {heroDistance}
        </div>
        <div className="dim small" data-testid="hero-distance-unit" style={{ fontWeight: 600 }}>
          {distUnitLabel}
        </div>
      </div>

      {/* Secondary Metrics 2x2 Grid */}
      <div
        className="metrics-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 10,
          marginBottom: 14,
        }}
      >
        {/* Duration */}
        <div className="card" style={{ padding: 12 }}>
          <div className="muted small">{t('Time')}</div>
          <div
            data-testid="metric-duration"
            style={{
              fontSize: '1.7rem',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              marginTop: 2,
            }}
          >
            {durationClock}
          </div>
        </div>

        {/* Pace / Speed */}
        <div className="card" style={{ padding: 12 }}>
          <div className="muted small">{isRide ? t('Speed') : t('Pace')}</div>
          <div
            data-testid="metric-rate"
            style={{
              fontSize: '1.7rem',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              marginTop: 2,
            }}
          >
            {rateDisplay}
          </div>
        </div>

        {/* Elevation Gain */}
        <div className="card" style={{ padding: 12 }}>
          <div className="muted small">{t('Elevation')}</div>
          <div
            data-testid="metric-elevation"
            style={{
              fontSize: '1.7rem',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              marginTop: 2,
            }}
          >
            {elevationDisplay}
          </div>
        </div>

        {/* Calories */}
        <div className="card" style={{ padding: 12 }}>
          <div className="muted small">{t('Calories')}</div>
          <div
            data-testid="metric-calories"
            style={{
              fontSize: '1.7rem',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              marginTop: 2,
            }}
          >
            {caloriesDisplay}
          </div>
        </div>
      </div>

      {/* Live Route Map Trail */}
      <div
        className="card"
        style={{
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          marginBottom: 16,
          background: 'var(--surface-1)',
        }}
      >
        <RouteCanvas
          points={points}
          width={340}
          height={170}
          strokeColor="var(--acc, #3b82f6)"
          startColor="#22c55e"
          endColor="#ef4444"
        />
        <div className="dim small" style={{ marginTop: 6 }} data-testid="points-count-label">
          {points.length} {t('GPS points')}
        </div>
      </div>

      {/* Recording Controls: Pause/Resume + Discard + Long-Press Finish */}
      <div
        className="recording-controls"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div className="row" style={{ gap: 10 }}>
          {/* Pause / Resume Button */}
          {isPaused ? (
            <Button
              variant="primary"
              icon="play"
              data-testid="resume-btn"
              style={{
                flex: 2,
                height: 52,
                fontSize: 16,
                fontWeight: 700,
                background: 'var(--acc, #3b82f6)',
              }}
              onClick={handleResume}
            >
              {t('Resume')}
            </Button>
          ) : (
            <Button
              variant="outline"
              icon="pause"
              data-testid="pause-btn"
              style={{
                flex: 2,
                height: 52,
                fontSize: 16,
                fontWeight: 700,
                borderColor: 'var(--yellow, #f59e0b)',
                color: 'var(--yellow, #f59e0b)',
              }}
              onClick={handlePause}
            >
              {t('Pause')}
            </Button>
          )}

          {/* Discard Button */}
          <Button
            variant="ghost"
            data-testid="discard-btn"
            style={{
              flex: 1,
              height: 52,
              fontSize: 14,
              color: 'var(--red, #ef4444)',
            }}
            onClick={handleDiscard}
          >
            {t('Discard')}
          </Button>
        </div>

        {/* Long-Press Finish Button */}
        <div
          className="long-press-finish-container"
          style={{ position: 'relative', width: '100%', userSelect: 'none' }}
        >
          <button
            type="button"
            data-testid="finish-btn"
            className="btn finish-long-press-btn"
            style={{
              position: 'relative',
              width: '100%',
              height: 58,
              fontSize: 16,
              fontWeight: 700,
              background: 'var(--surface-2)',
              color: 'var(--red, #ef4444)',
              border: '2px solid var(--red, #ef4444)',
              borderRadius: 12,
              overflow: 'hidden',
              cursor: isFinishing ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              touchAction: 'none',
            }}
            onMouseDown={startHold}
            onMouseUp={cancelHold}
            onMouseLeave={cancelHold}
            onTouchStart={startHold}
            onTouchEnd={cancelHold}
            onTouchCancel={cancelHold}
            onKeyDown={e => {
              if (e.key === ' ' || e.key === 'Enter') startHold(e)
            }}
            onKeyUp={cancelHold}
          >
            {/* Dynamic Progress Fill Bar */}
            <div
              data-testid="hold-progress-fill"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${holdProgress}%`,
                background: 'var(--red, #ef4444)',
                opacity: 0.35,
                pointerEvents: 'none',
                transition: holdProgress === 0 ? 'width 0.15s ease' : 'none',
              }}
            />

            <span
              style={{
                position: 'relative',
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Icon name="check" />
              <span>
                {isFinishing
                  ? t('Saving…')
                  : holdProgress > 0
                  ? `${t('Hold to Finish')} (${Math.round(holdProgress)}%)`
                  : t('Hold to Finish')}
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
