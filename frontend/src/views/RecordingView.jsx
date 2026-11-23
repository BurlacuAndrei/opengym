import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useStore, accumulateGearDistance } from '../store/useStore.js'
import Icon from '../components/Icon.jsx'
import { Button, Switch } from '../components/ui.jsx'
import RouteCanvas from '../components/RouteCanvas.jsx'
import IntervalEditor from '../components/IntervalEditor.jsx'
import { openManualCardioSheet } from '../components/ManualCardioSheet.jsx'
import { openGpxImportDialog } from '../components/GpxImportDialog.jsx'
import { dedupeRoutes } from './Library.jsx'
import { t } from '../lib/i18n.js'
import { todayISO } from '../lib/format.js'
import { effectiveDaySessions } from '../lib/history.js'
import { getCardioPlans, formatCardioTarget } from '../lib/cardio-plan.js'
import { lazyFetchRoute } from '../lib/track-sync.js'
import { createRouteFollower, formatOffCourseAlert } from '../lib/route-follower.js'
import { MOBILE } from '../lib/mobile.js'
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
import { createIntervalRunner } from '../lib/interval-runner.js'
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

export const RECORDING_SPORTS = ['run', 'ride', 'walk', 'hike', 'swim', 'row']

export function sportIcon(type) {
  if (type === 'ride') return 'bike'
  if (type === 'swim') return 'swim'
  if (type === 'row') return 'bolt'
  return 'figureRun'
}

export function gearCategoryForSport(sport) {
  return sport === 'ride' ? 'bike' : 'shoe'
}

export function resolveDefaultGearForSport(gearList, sport) {
  const active = (Array.isArray(gearList) ? gearList : []).filter(g => g && !g.retired)
  if (active.length === 0) return ''
  const cat = gearCategoryForSport(sport)
  const matching = active.filter(g => g.type === cat)
  const defMatch = matching.find(g => g.isDefault)
  if (defMatch) return defMatch.id
  if (matching.length > 0) return matching[0].id
  const anyDef = active.find(g => g.isDefault)
  return anyDef ? anyDef.id : ''
}

export function finalizeRecordingLinks(
  activity,
  {
    selectedGearId = '',
    selectedPlanId = '',
    accumulateGearFn = accumulateGearDistance,
    updateCardioActivityFn = null,
    updateStoreFn = null,
  } = {}
) {
  if (!activity) return
  if (selectedGearId) {
    if (activity.distanceM > 0 && typeof accumulateGearFn === 'function') {
      accumulateGearFn(selectedGearId, activity.distanceM)
    }
    if (activity.id && typeof updateCardioActivityFn === 'function') {
      updateCardioActivityFn(activity.id, { gearId: selectedGearId })
    }
  }
  if (selectedPlanId && typeof updateStoreFn === 'function') {
    updateStoreFn(s => {
      if (!Array.isArray(s.cardioPlans)) return
      const plan = s.cardioPlans.find(p => p && p.id === selectedPlanId)
      if (plan) {
        plan.completed = true
        if (activity.id) plan.completedActivityId = activity.id
      }
    })
  }
}

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
  intervalSteps = null,
  intervalRunner = null,
}) {
  let navigate = () => {}
  let location = null
  try {
    navigate = useNavigate()
    location = useLocation()
  } catch {
    // Router context optional for testing/embedding
  }
  const S = useStore(s => s.S) || {}
  const update = useStore(s => s.update)
  const updateCardioActivity = useStore(s => s.updateCardioActivity)
  const unit = S?.unit === 'lb' ? 'lbs' : (S?.unit || 'kg')

  // Resolve recorder instance
  const rec = recorder || getCardioRecorder()

  // Planned cardio, saved routes, and active gear resolution
  const cardioPlans = getCardioPlans(S)
  const todayPlannedCardio = effectiveDaySessions(S, todayISO()).cardioPlans.find(p => !p.completed) || null
  const savedRoutes = dedupeRoutes(S)
  const activeGear = (Array.isArray(S.gear) ? S.gear : []).filter(g => g && !g.retired)

  const statePlanId = location?.state?.cardioPlanId || location?.state?.cardioPlan?.id || ''
  const defaultPlanId = statePlanId || todayPlannedCardio?.id || ''

  const searchParams = typeof location?.search === 'string' ? new URLSearchParams(location.search) : null
  const queryRouteId = searchParams ? (searchParams.get('route') || '') : ''
  const defaultRouteId = location?.state?.followRouteId || location?.state?.followRoute?.id || queryRouteId || ''

  // Interval Runner instance
  const initialSteps = intervalSteps || rec?.intervalSteps || null
  const runnerRef = useRef(null)
  if (!runnerRef.current && (intervalRunner || initialSteps)) {
    runnerRef.current = intervalRunner || createIntervalRunner({
      steps: initialSteps,
      adapter: rec?.adapter,
      unit,
      S,
    })
  }
  const [, setRunnerTick] = useState(0)

  // Component state
  const [recState, setRecState] = useState(() => rec.getState())
  const [liveStats, setLiveStats] = useState(() => rec.getLiveStats())
  const [points, setPoints] = useState(() => (rec.points ? [...rec.points] : []))
  const routeActivityType = location?.state?.activityType || location?.state?.cardioPlan?.type
  const validRouteType = RECORDING_SPORTS.includes(routeActivityType)
    ? routeActivityType
    : null
  const [selectedType, setSelectedType] = useState(
    recState?.status !== RECORDING_STATUS.IDLE
      ? (recState?.activityType || 'run')
      : (validRouteType || initialActivityType || recState?.activityType || 'run')
  )
  const [selectedPlanId, setSelectedPlanId] = useState(defaultPlanId)
  const [customIntervalsOn, setCustomIntervalsOn] = useState(false)
  const [customSteps, setCustomSteps] = useState([])
  const [selectedRouteId, setSelectedRouteId] = useState(defaultRouteId)
  const [followedRoutePoints, setFollowedRoutePoints] = useState(() =>
    Array.isArray(location?.state?.followRoute?.points) ? location.state.followRoute.points : null
  )
  const routeFollowerRef = useRef(null)
  const [routeStatus, setRouteStatus] = useState(null)
  const [gearTouched, setGearTouched] = useState(false)
  const [selectedGearId, setSelectedGearId] = useState(() =>
    resolveDefaultGearForSport(S.gear, validRouteType || initialActivityType || 'run')
  )
  const gpxInputRef = useRef(null)
  const [finalizedActivity, setFinalizedActivity] = useState(null)
  const [isFinishing, setIsFinishing] = useState(false)

  // Long press finish state
  const [holdProgress, setHoldProgress] = useState(0)
  const holdTimerRef = useRef(null)
  const holdStartRef = useRef(null)

  // Wake lock keeps the display awake while actively recording
  useWakeLock(recState?.status === RECORDING_STATUS.RECORDING)

  // Sync route state activityType when idle
  useEffect(() => {
    if (recState?.status === RECORDING_STATUS.IDLE && validRouteType) {
      setSelectedType(validRouteType)
    }
  }, [validRouteType, recState?.status])

  // Keep default gear synced to sport until athlete picks manually
  useEffect(() => {
    if (!gearTouched && recState?.status === RECORDING_STATUS.IDLE) {
      setSelectedGearId(resolveDefaultGearForSport(S.gear, selectedType))
    }
  }, [selectedType, gearTouched, S.gear, recState?.status])

  // Load selected route track points & initialize RouteFollower
  useEffect(() => {
    let active = true
    if (!selectedRouteId) {
      setFollowedRoutePoints(null)
      routeFollowerRef.current = null
      setRouteStatus(null)
      return () => { active = false }
    }
    const routeObj = savedRoutes.find(r => r.id === selectedRouteId) || location?.state?.followRoute
    if (!routeObj) return () => { active = false }
    if (Array.isArray(routeObj.points) && routeObj.points.length > 0) {
      setFollowedRoutePoints(routeObj.points)
      routeFollowerRef.current = createRouteFollower(routeObj.points, { offCourseThresholdMeters: 100 })
      return () => { active = false }
    }
    lazyFetchRoute(routeObj).then(data => {
      if (!active || !data) return
      const pts = Array.isArray(data.points) ? data.points : (Array.isArray(data) ? data : [])
      if (pts.length > 0) {
        setFollowedRoutePoints(pts)
        routeFollowerRef.current = createRouteFollower(pts, { offCourseThresholdMeters: 100 })
      }
    }).catch(() => {})
    return () => { active = false }
  }, [selectedRouteId])

  // Update RouteFollower status as GPS points arrive
  useEffect(() => {
    if (!routeFollowerRef.current || !points.length) return
    const lastPt = points[points.length - 1]
    if (lastPt && typeof routeFollowerRef.current.update === 'function') {
      const status = routeFollowerRef.current.update(lastPt)
      setRouteStatus(status)
    }
  }, [points])

  // Subscribe to recorder state changes
  useEffect(() => {
    const syncState = state => {
      setRecState({ ...state })
      setLiveStats({ ...state.liveStats })
      setPoints(rec.points ? [...rec.points] : [])
      if (runnerRef.current && state.status === RECORDING_STATUS.RECORDING) {
        runnerRef.current.update(state.liveStats).then(() => setRunnerTick(t => t + 1))
      }
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
      const stats = rec.getLiveStats()
      setLiveStats({ ...stats })
      if (runnerRef.current) {
        runnerRef.current.update(stats).then(() => setRunnerTick(t => t + 1))
      }
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
  const activityType =
    recState?.status !== RECORDING_STATUS.IDLE
      ? (recState?.activityType || selectedType || 'run')
      : (selectedType || 'run')
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

  const selectedPlan = cardioPlans.find(p => p.id === selectedPlanId) || null

  // Action handlers
  const handleStart = async () => {
    const activeSteps = customIntervalsOn && customSteps.length > 0
      ? customSteps
      : (selectedPlan?.intervals && selectedPlan.intervals.length > 0 ? selectedPlan.intervals : initialSteps)

    if (!runnerRef.current && Array.isArray(activeSteps) && activeSteps.length > 0) {
      runnerRef.current = createIntervalRunner({
        steps: activeSteps,
        adapter: rec?.adapter,
        unit,
        S,
      })
    }

    const startOpts = {
      type: selectedType,
      ...(selectedGearId ? { gearId: selectedGearId } : {}),
      ...(selectedPlanId ? { planId: selectedPlanId } : {}),
    }
    await (rec.startRecording ? rec.startRecording(startOpts) : defaultStartRecording(startOpts))
    if (runnerRef.current && runnerRef.current.status === 'idle') {
      await runnerRef.current.start(rec.getLiveStats ? rec.getLiveStats() : {})
      setRunnerTick(t => t + 1)
    }
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
      const intervalSplits = runnerRef.current ? runnerRef.current.splits : null
      const finishOpts = {
        intervalSplits,
        ...(selectedGearId ? { gearId: selectedGearId } : {}),
      }
      const activity = rec.finishRecording
        ? await rec.finishRecording(finishOpts)
        : await defaultFinishRecording(finishOpts)
      finalizeRecordingLinks(activity, {
        selectedGearId,
        selectedPlanId,
        accumulateGearFn: accumulateGearDistance,
        updateCardioActivityFn: updateCardioActivity,
        updateStoreFn: update,
      })
      setFinalizedActivity(activity)
    } catch (err) {
      console.error('Failed to finish recording:', err)
    } finally {
      setIsFinishing(false)
      setHoldProgress(0)
    }
  }, [rec, isFinishing, selectedGearId, selectedPlanId, updateCardioActivity, update])

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
  // View 2: Idle Screen (Pre-Start Cardio Recording Setup)
  // ---------------------------------------------------------------------------
  if (isIdle) {
    const handleGpxFile = ev => {
      const file = ev.target.files?.[0]
      ev.target.value = ''
      if (file) openGpxImportDialog({ file })
    }
    return (
      <div className="narrow recording-idle-view" data-testid="recording-idle">
        <div className="hdr">
          <div>
            <h1>{t('Record Cardio')}</h1>
            <div className="sub">{t('GPS-tracked workout')}</div>
          </div>
        </div>

        <div className="card">
          <h2 style={{ margin: '0 0 10px 0' }}>{t('Select Activity')}</h2>
          <div
            data-testid="sport-selector"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 8,
              marginBottom: 16,
            }}
          >
            {RECORDING_SPORTS.map(type => (
              <button
                key={type}
                type="button"
                data-testid={`sport-btn-${type}`}
                className={`item ${selectedType === type ? 'selected' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 8px',
                  borderRadius: 10,
                  border: selectedType === type ? '2px solid var(--acc)' : '1px solid var(--sep)',
                  background: selectedType === type ? 'var(--surface-2)' : 'var(--surface)',
                  cursor: 'pointer',
                }}
                onClick={() => setSelectedType(type)}
              >
                <Icon name={sportIcon(type)} />
                <span style={{ textTransform: 'capitalize', fontWeight: 600, fontSize: 13 }}>{t(type)}</span>
              </button>
            ))}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div className="lbl2" style={{ marginBottom: 6 }}>{t('Planned Target / Intervals')}</div>
            <select
              data-testid="plan-selector"
              value={selectedPlanId}
              onChange={e => {
                const pid = e.target.value
                setSelectedPlanId(pid)
                const matched = cardioPlans.find(p => p.id === pid)
                if (matched?.type && RECORDING_SPORTS.includes(matched.type)) {
                  setSelectedType(matched.type)
                }
              }}
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: 10,
                border: '1px solid var(--sep)',
                background: 'var(--surface-2)',
                color: 'var(--label)',
              }}
            >
              <option value="">{t('Free recording (no target)')}</option>
              {cardioPlans.map(cp => (
                <option key={cp.id} value={cp.id}>
                  {formatCardioTarget(cp, unit)}{cp.completed ? ` (${t('Done')})` : ''}
                </option>
              ))}
            </select>
            <div className="row between" style={{ marginTop: 8 }}>
              <span className="small muted">{t('Custom intervals')}</span>
              <Switch checked={customIntervalsOn} onChange={setCustomIntervalsOn} />
            </div>
            {customIntervalsOn && (
              <div style={{ marginTop: 8 }}>
                <IntervalEditor steps={customSteps} onChange={setCustomSteps} unit={unit} />
              </div>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div className="lbl2" style={{ marginBottom: 6 }}>{t('Follow Route')}</div>
            <select
              data-testid="route-selector"
              value={selectedRouteId}
              onChange={e => setSelectedRouteId(e.target.value)}
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: 10,
                border: '1px solid var(--sep)',
                background: 'var(--surface-2)',
                color: 'var(--label)',
              }}
            >
              <option value="">{t('None')}</option>
              {savedRoutes.map(r => (
                <option key={r.id} value={r.id}>
                  {r.name || t('Unnamed Route')} ({fmtDist(r.distanceM || 0, unit)})
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div className="lbl2" style={{ marginBottom: 6 }}>{t('Active Gear')}</div>
            <select
              data-testid="gear-selector"
              value={selectedGearId}
              onChange={e => {
                setGearTouched(true)
                setSelectedGearId(e.target.value)
              }}
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: 10,
                border: '1px solid var(--sep)',
                background: 'var(--surface-2)',
                color: 'var(--label)',
              }}
            >
              <option value="">{t('No gear selected')}</option>
              {activeGear.map(g => (
                <option key={g.id} value={g.id}>
                  {g.name}{g.isDefault ? ` (${t('Default')})` : ''}
                </option>
              ))}
            </select>
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

        {!MOBILE && (
          <div className="card" data-testid="web-fallback-banner">
            <div className="row" style={{ gap: 10, marginBottom: 10 }}>
              <span className="lrow-i" style={{ '--tint': 'var(--pillar-cardio)' }}>
                <Icon name="globe" />
              </span>
              <div className="grow">
                <div className="tt">{t('Browser GPS & Indoor Timer')}</div>
                <div className="ss">{t('Web uses browser geolocation while open, or log indoor/outdoor cardio manually.')}</div>
              </div>
            </div>
            <input
              ref={gpxInputRef}
              type="file"
              accept=".gpx,application/gpx+xml,text/xml"
              style={{ display: 'none' }}
              onChange={handleGpxFile}
            />
            <div className="row" style={{ gap: 8 }}>
              <Button style={{ flex: 1 }} icon="plus" onClick={() => openManualCardioSheet()}>
                {t('Log Manual Cardio')}
              </Button>
              <Button style={{ flex: 1 }} icon="upload" onClick={() => gpxInputRef.current?.click()}>
                {t('Import GPX')}
              </Button>
            </div>
          </div>
        )}
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

      {/* Structured Interval Mode Step Banner (Issue #76) */}
      {runnerRef.current && (
        <div
          className="interval-banner card"
          data-testid="interval-runner-banner"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            marginBottom: 12,
            background: 'var(--surface-1)',
            borderLeft: `4px solid ${
              runnerRef.current.status === 'cooldown'
                ? 'var(--yellow, #f59e0b)'
                : 'var(--acc, #3b82f6)'
            }`,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color:
                  runnerRef.current.status === 'cooldown'
                    ? 'var(--yellow, #f59e0b)'
                    : 'var(--acc, #3b82f6)',
              }}
              data-testid="interval-runner-status"
            >
              {runnerRef.current.status === 'cooldown' ? t('Cooldown') : t('Interval Mode')}
            </div>
            <div
              style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}
              data-testid="interval-current-step-label"
            >
              {runnerRef.current.currentStep
                ? runnerRef.current.getStepLabel()
                : t('Workout Complete')}
            </div>
          </div>
          {runnerRef.current.currentStep && (
            <div
              style={{ fontSize: 13, color: 'var(--muted, #94a3b8)', fontWeight: 600 }}
              data-testid="interval-step-cue"
            >
              {runnerRef.current.getStepCue()}
            </div>
          )}
        </div>
      )}

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

      {/* Off-route alert banner */}
      {routeStatus?.isOffCourse && (
        <div
          className="card"
          data-testid="off-route-banner"
          style={{
            padding: '10px 14px',
            marginBottom: 12,
            borderLeft: '4px solid var(--orange)',
            color: 'var(--orange)',
            fontWeight: 600,
          }}
        >
          {formatOffCourseAlert(routeStatus.distanceFromRouteMeters)}
        </div>
      )}

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
          referencePoints={followedRoutePoints}
          currentPosition={points.length ? points[points.length - 1] : null}
          isOffCourse={!!routeStatus?.isOffCourse}
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
