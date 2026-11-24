import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
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
import { getActiveGear, gearCategoryForSport, resolveDefaultGearForSport } from '../lib/gear.js'
import { createRouteFollower, formatOffCourseAlert } from '../lib/route-follower.js'
import { speakCardioCue } from '../lib/cardio-tts.js'
import { MOBILE } from '../lib/mobile.js'
import { useWakeLock } from '../lib/wakelock.js'
import {
  canOpenLocationSettings,
  openLocationSettings,
  checkLocationPermission,
} from '../lib/cardio-adapter.js'
import {
  RECORDING_STATUS,
  isFatalGpsError,
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
  fmtPaceSec,
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

export { gearCategoryForSport, resolveDefaultGearForSport }

export function finalizeRecordingLinks(
  activity,
  {
    selectedGearId = '',
    selectedPlanId = '',
    gearAlreadyApplied = false,
    accumulateGearFn = accumulateGearDistance,
    updateCardioActivityFn = null,
    updateStoreFn = null,
  } = {}
) {
  if (!activity) return
  if (selectedGearId && !gearAlreadyApplied) {
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

export function formatGpsError(err, { canOpenSettings = canOpenLocationSettings() } = {}) {
  const msg = typeof err === 'string' ? err : (err?.message || '')
  const isPermission = err?.code === 1 || /permission|denied|not allowed/i.test(msg)
  if (isPermission) {
    return {
      title: t('Location permission denied'),
      message: canOpenSettings
        ? t('Open Settings → Permissions → Location to allow location access for GPS cardio, or log cardio manually.')
        : t('Enable location access in your browser site settings to record GPS cardio, or log cardio manually.'),
      isPermission: true,
    }
  }
  return {
    title: t('GPS unavailable'),
    message: t('Could not start GPS tracking on this device. Try again or log cardio manually.'),
    isPermission: false,
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

export const FOLLOW_STATE_ROUTE_ID = '__follow_route__'

function getExplicitRouteId(location) {
  const searchParams = typeof location?.search === 'string' ? new URLSearchParams(location.search) : null
  const queryRouteId = searchParams ? (searchParams.get('route') || '') : ''
  return location?.state?.followRouteId || location?.state?.followRoute?.id || queryRouteId || ''
}

/**
 * Resolves initial selected route ID from URL query or navigation state.
 *
 * @param {Object|null} location
 * @returns {string}
 */
export function resolveInitialRouteId(location) {
  const explicitId = getExplicitRouteId(location)
  if (explicitId) return explicitId
  const followRoute = location?.state?.followRoute
  if (followRoute && Array.isArray(followRoute.points) && followRoute.points.length > 0) {
    return FOLLOW_STATE_ROUTE_ID
  }
  return ''
}

/**
 * Resolves initial route points from savedRoutes or navigation followRoute state.
 *
 * @param {string} selectedRouteId
 * @param {Array} savedRoutes
 * @param {Object|null} followRouteState
 * @returns {Array|null}
 */
export function resolveFollowRoute(selectedRouteId, savedRoutes, followRouteState) {
  const routes = Array.isArray(savedRoutes) ? savedRoutes : []
  if (!selectedRouteId) {
    return null
  }
  const saved = routes.find(r => r && r.id === selectedRouteId)
  if (Array.isArray(saved?.points) && saved.points.length > 0) {
    return saved.points
  }
  if (
    followRouteState &&
    (!followRouteState.id || followRouteState.id === selectedRouteId) &&
    Array.isArray(followRouteState.points) &&
    followRouteState.points.length > 0
  ) {
    return followRouteState.points
  }
  return null
}

/**
 * Resolves both target route metadata object and direct points for a selected route ID.
 * Only passes location.state.followRoute when it explicitly matches selectedRouteId.
 *
 * @param {string} selectedRouteId
 * @param {Array} savedRoutes
 * @param {Object|null} location
 * @returns {{ routeObj: Object|null, points: Array|null }}
 */
export function resolveFollowRouteTarget(selectedRouteId, savedRoutes, location) {
  if (!selectedRouteId) {
    return { routeObj: null, points: null }
  }
  const routes = Array.isArray(savedRoutes) ? savedRoutes : []
  const followRouteState = location?.state?.followRoute || null
  const explicitId = getExplicitRouteId(location)
  const matchingFollowState =
    followRouteState &&
    (followRouteState.id === selectedRouteId ||
      (!followRouteState.id && selectedRouteId === (explicitId || FOLLOW_STATE_ROUTE_ID)))
      ? followRouteState
      : null
  const routeObj = routes.find(r => r && r.id === selectedRouteId) || matchingFollowState
  const points = resolveFollowRoute(selectedRouteId, routes, matchingFollowState)
  return { routeObj, points }
}

/**
 * Evaluates current GPS position against a RouteFollower instance.
 *
 * @param {Object|null} follower
 * @param {Array} points
 * @returns {Object|null}
 */
export function evaluateRouteFollower(follower, points) {
  if (!follower || !Array.isArray(points) || !points.length) {
    if (follower && typeof follower.reset === 'function') {
      follower.reset()
    }
    return null
  }
  const lastPt = points[points.length - 1]
  if (!lastPt || typeof follower.updatePosition !== 'function') {
    return null
  }
  return follower.updatePosition(lastPt)
}

/**
 * Creates a RouteFollower configured with live recording TTS gating and throttle reset when paused/idle.
 *
 * @param {Array} pts
 * @param {Function|Object} getDeps
 * @returns {Object}
 */
export function createRecordingRouteFollower(pts, getDeps) {
  let follower = null
  follower = createRouteFollower(pts, {
    offCourseThresholdMeters: 100,
    speak: (text, opts) => {
      const { rec, S, recStatus } =
        (typeof getDeps === 'function' ? getDeps() : getDeps) || {}
      if (recStatus !== RECORDING_STATUS.RECORDING) {
        follower?.resetAlertThrottle?.()
        return
      }
      try {
        Promise.resolve(
          speakCardioCue(text, {
            adapter: rec?.adapter,
            S,
            duck: S?.voiceDucking === false ? false : (opts?.duck !== false),
          })
        ).catch(() => {})
      } catch {
        // Ignore TTS errors
      }
    },
  })
  return follower
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
  initialFinalizedActivity = null,
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
  const activeGear = getActiveGear(S.gear)

  const statePlanId = location?.state?.cardioPlanId || location?.state?.cardioPlan?.id || ''
  const defaultPlanId = statePlanId || todayPlannedCardio?.id || ''

  const defaultRouteId = resolveInitialRouteId(location)
  const initialFollowTarget = resolveFollowRouteTarget(defaultRouteId, savedRoutes, location)
  const extraFollowOption =
    defaultRouteId &&
    initialFollowTarget.routeObj &&
    !savedRoutes.some(r => r && r.id === defaultRouteId)
      ? { ...initialFollowTarget.routeObj, id: defaultRouteId }
      : null

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
    initialFollowTarget.points
  )
  const routeFollowerRef = useRef(null)
  const lastRouteEvalRef = useRef({ follower: null, point: null })
  const latestRouteDepsRef = useRef({ rec, S, recStatus: recState?.status })
  latestRouteDepsRef.current = { rec, S, recStatus: recState?.status }
  const [routeStatus, setRouteStatus] = useState(() => {
    if (
      recState?.status === RECORDING_STATUS.IDLE ||
      !Array.isArray(followedRoutePoints) ||
      !followedRoutePoints.length ||
      !points.length
    ) {
      return null
    }
    const follower = createRouteFollower(followedRoutePoints, { offCourseThresholdMeters: 100 })
    return evaluateRouteFollower(follower, points)
  })
  const [gearTouched, setGearTouched] = useState(false)
  const [selectedGearId, setSelectedGearId] = useState(() =>
    resolveDefaultGearForSport(S.gear, validRouteType || initialActivityType || 'run')
  )
  const gpxInputRef = useRef(null)
  const [finalizedActivity, setFinalizedActivity] = useState(initialFinalizedActivity)
  const [isFinishing, setIsFinishing] = useState(false)
  const [gpsError, setGpsError] = useState(null)
  const [isStarting, setIsStarting] = useState(false)

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

  const makeFollower = useCallback(
    pts => createRecordingRouteFollower(pts, () => latestRouteDepsRef.current),
    []
  )

  // Load selected route track points & initialize RouteFollower
  useEffect(() => {
    let active = true
    const clearRouteFollow = () => {
      setFollowedRoutePoints(null)
      routeFollowerRef.current = null
      lastRouteEvalRef.current = { follower: null, point: null }
      setRouteStatus(null)
    }
    const { routeObj, points: directPts } = resolveFollowRouteTarget(
      selectedRouteId,
      savedRoutes,
      location
    )
    if (!selectedRouteId || !routeObj) {
      clearRouteFollow()
      return () => { active = false }
    }
    if (directPts) {
      routeFollowerRef.current = makeFollower(directPts)
      setFollowedRoutePoints(directPts)
      return () => { active = false }
    }
    clearRouteFollow()
    lazyFetchRoute(routeObj).then(data => {
      if (!active || !data) return
      const pts = Array.isArray(data.points) ? data.points : (Array.isArray(data) ? data : [])
      if (pts.length > 0) {
        routeFollowerRef.current = makeFollower(pts)
        setFollowedRoutePoints(pts)
      }
    }).catch(() => {})
    return () => { active = false }
  }, [selectedRouteId, makeFollower])

  // Update RouteFollower status as GPS points arrive
  useEffect(() => {
    const follower = routeFollowerRef.current
    const recStatus = recState?.status
    if (!follower || !points.length || recStatus === RECORDING_STATUS.IDLE) {
      if (follower && typeof follower.reset === 'function') {
        follower.reset()
      }
      lastRouteEvalRef.current = { follower: null, point: null }
      setRouteStatus(null)
      return
    }
    const lastPt = points[points.length - 1]
    if (
      lastRouteEvalRef.current.follower === follower &&
      lastRouteEvalRef.current.point === lastPt
    ) {
      return
    }
    lastRouteEvalRef.current = { follower, point: lastPt }
    setRouteStatus(evaluateRouteFollower(follower, points))
  }, [points, followedRoutePoints, recState?.status])

  // Subscribe to recorder state changes
  useEffect(() => {
    const syncState = state => {
      setRecState({ ...state })
      setLiveStats({ ...state.liveStats })
      setPoints(rec.points ? [...rec.points] : [])
      if (state.status === RECORDING_STATUS.RECORDING && state.pointsCount > 0) {
        setGpsError(null)
      }
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

  // Auto-clear permission error banner if user grants location permission in OS/browser settings
  const hasPermissionError = Boolean(gpsError?.isPermission)
  useEffect(() => {
    if (!hasPermissionError) return
    let active = true
    let checking = false

    const recheckPermission = async () => {
      if (!active || checking) return
      checking = true
      try {
        const granted = await checkLocationPermission()
        if (granted && active) {
          setGpsError(prev => (prev?.isPermission ? null : prev))
        }
      } catch {
        // Ignore transient permission check failures on resume
      } finally {
        checking = false
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        recheckPermission()
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', recheckPermission)
    }

    let resumeListener = null
    if (Capacitor?.isNativePlatform?.() || typeof document !== 'undefined') {
      try {
        resumeListener = Promise.resolve(CapApp?.addListener?.('resume', recheckPermission))
        resumeListener.catch(() => {})
      } catch {
        // Ignore unavailable Capacitor App listener
      }
    }

    return () => {
      active = false
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', recheckPermission)
      }
      if (resumeListener) {
        resumeListener.then(handle => handle?.remove?.()).catch(() => {})
      }
    }
  }, [hasPermissionError])

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
  const handleGpsError = useCallback(async (err, forceFatal = false) => {
    if (!forceFatal && !isFatalGpsError(err)) return
    const status = rec.getState?.()?.status
    if (status && status !== RECORDING_STATUS.IDLE) {
      try {
        if (rec.discardRecording) await rec.discardRecording()
        else await defaultDiscardRecording()
      } catch {
        // Ignore cleanup errors during fatal GPS failure
      }
    }
    if (!intervalRunner) {
      runnerRef.current = null
    }
    rec.adapter?.stopSpeaking?.()
    setGpsError(formatGpsError(err))
  }, [rec, intervalRunner])

  const handleOpenSettings = useCallback(async () => {
    await openLocationSettings()
  }, [])

  const handleStart = async () => {
    if (isStarting) return
    setIsStarting(true)
    setGpsError(null)
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
      onError: handleGpsError,
      ...(selectedGearId ? { gearId: selectedGearId } : {}),
      ...(selectedPlanId ? { planId: selectedPlanId } : {}),
    }
    try {
      const nextState = await (rec.startRecording ? rec.startRecording(startOpts) : defaultStartRecording(startOpts))
      const activeStatus = nextState?.status ?? rec.getState?.()?.status
      if (activeStatus === RECORDING_STATUS.RECORDING && runnerRef.current && runnerRef.current.status === 'idle') {
        await runnerRef.current.start(rec.getLiveStats ? rec.getLiveStats() : {})
        setRunnerTick(t => t + 1)
      }
    } catch (err) {
      await handleGpsError(err, true)
    } finally {
      setIsStarting(false)
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
      const storeApi = useStore.getState?.()
      let persisted = activity?.id
        ? (storeApi?.S?.cardioActivities || []).find(a => a && a.id === activity.id)
        : null
      if (!persisted && activity?.id && typeof storeApi?.logCardioActivity === 'function') {
        persisted = storeApi.logCardioActivity({
          ...activity,
          ...(selectedGearId && !activity.gearId ? { gearId: selectedGearId } : {}),
        })
      }
      finalizeRecordingLinks(activity, {
        selectedGearId,
        selectedPlanId,
        gearAlreadyApplied: Boolean(selectedGearId && persisted?.gearId === selectedGearId),
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
    const summaryRate = fmtPaceSec(finalizedActivity.avgPaceSecKm, unit)
      || (finalizedActivity.avgSpeedKmh ? formatSpeed(finalizedActivity.avgSpeedKmh, unit) : rateDisplay)

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
    const showOpenSettings = Boolean(gpsError?.isPermission && canOpenLocationSettings())
    return (
      <div className="narrow recording-idle-view" data-testid="recording-idle">
        <div className="hdr">
          <div>
            <h1>{t('Record Cardio')}</h1>
            <div className="sub">{t('GPS-tracked workout')}</div>
          </div>
        </div>

        {gpsError && (
          <div
            role="alert"
            className="card"
            data-testid="recording-error-banner"
            style={{
              border: '1px solid var(--red)',
              background: 'var(--surface)',
              marginBottom: 14,
            }}
          >
            <div className="row" style={{ gap: 10, marginBottom: 10, alignItems: 'flex-start' }}>
              <span className="lrow-i" style={{ '--tint': 'var(--red)', color: 'var(--red)' }}>
                <Icon name="info" />
              </span>
              <div className="grow">
                <div style={{ fontWeight: 600, color: 'var(--label)', marginBottom: 2 }}>
                  {gpsError.title}
                </div>
                <div style={{ fontSize: 13, color: 'var(--label-2)', lineHeight: 1.4 }}>
                  {gpsError.message}
                </div>
              </div>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {showOpenSettings && (
                <Button
                  variant="primary"
                  size="sm"
                  icon="gear"
                  data-testid="open-settings-btn"
                  style={{ minHeight: 44, minWidth: 44 }}
                  onClick={handleOpenSettings}
                >
                  {t('Open Settings')}
                </Button>
              )}
              <Button
                variant={showOpenSettings ? 'secondary' : 'tinted'}
                size={showOpenSettings ? 'sm' : undefined}
                icon="plus"
                style={{ flex: 1, minHeight: 44 }}
                onClick={() => openManualCardioSheet()}
              >
                {t('Log Manual Cardio')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                style={{ minHeight: 44, minWidth: 44 }}
                onClick={() => setGpsError(null)}
              >
                {t('Dismiss')}
              </Button>
            </div>
          </div>
        )}

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
              {extraFollowOption && (
                <option value={extraFollowOption.id}>
                  {extraFollowOption.name || t('Unnamed Route')}
                  {extraFollowOption.distanceM ? ` (${fmtDist(extraFollowOption.distanceM, unit)})` : ''}
                </option>
              )}
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
            disabled={isStarting}
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
          {formatOffCourseAlert(routeStatus.crossTrackDistance)}
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
