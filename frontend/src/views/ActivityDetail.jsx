import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import { Button, Slider } from '../components/ui.jsx'
import RouteMap from '../components/RouteMap.jsx'
import PrBadge, { ActivityPrBadges } from '../components/PrBadge.jsx'
import { detectActivityPRs } from '../lib/pr.js'
import { exportGPX, sanitizeFilename, importGPXAsRoute } from '../lib/gpx-io.js'
import { trimTrackPoints, resolveTrackPath } from '../lib/track-trim.js'
import { getCardioAdapter, writeTrack } from '../lib/cardio-adapter.js'
import { lazyFetchTrack } from '../lib/track-sync.js'
import { api } from '../lib/api.js'
import { openManualCardioSheet } from '../components/ManualCardioSheet.jsx'
import { openConsentSheet } from '../components/ConsentSheet.jsx'
import { EXTERNAL_FEATURES } from '../lib/privacy.js'
import {
  ELEVATION_FEATURE_ID,
  hasElevationConsent,
  enrichTrackElevation,
} from '../lib/elevation-api.js'
import {
  haversineDistance,
  getPointEle,
  getPointTime,
  isValidPoint,
  rollingPace,
  smoothElevation,
  computeSplits,
  totalDistance,
} from '../lib/track-math.js'
import {
  fmtDist,
  fmtPace,
  fmtPaceSec,
  formatSpeed,
  formatElevation,
  formatDistance,
  formatSplitTime,
  defaultRateMetric,
  distanceUnit,
  paceUnit,
  elevationUnit,
} from '../lib/cardio-format.js'
import { fmtDate, fmtDur, fmtNum } from '../lib/format.js'

// Chart dimensions
const CHART_W = 500
const CHART_H = 130
const P = { l: 48, r: 16, t: 14, b: 24 }

export async function saveActivityAsRoute(activity, trackPoints, { isServerMode = false, nameFallback = 'Route' } = {}) {
  if (!Array.isArray(trackPoints) || trackPoints.length === 0) return null
  const opts = {}
  if (activity?.distanceM > 0) opts.distanceM = activity.distanceM
  if (activity?.elevationGainM != null) opts.elevationGainM = activity.elevationGainM
  const result = await importGPXAsRoute({
    name: activity?.name || nameFallback,
    desc: activity?.notes || '',
    points: trackPoints,
  }, opts)
  if (isServerMode && result?.route?.id) {
    try {
      await api(`/api/routes/${encodeURIComponent(result.route.id)}`, {
        method: 'PUT',
        body: JSON.stringify(result.routeData),
      })
    } catch (serverErr) {
      console.warn('Server route sync failed:', serverErr)
    }
  }
  return result
}

export async function correctActivityElevation(
  activity,
  trackData,
  trackPoints,
  { state, updateCardioActivity, isServerMode = false } = {}
) {
  if (!Array.isArray(trackPoints) || trackPoints.length === 0) return null
  const freshState = state || useStore.getState()?.S || {}
  const baseTrack = trackData && typeof trackData === 'object' && !Array.isArray(trackData)
    ? { ...trackData, points: trackPoints }
    : { ...activity, points: trackPoints }
  const enriched = await enrichTrackElevation(baseTrack, { state: freshState })
  if (Array.isArray(enriched?.elevations) && enriched.elevations.every(e => e == null)) {
    return { unavailable: true }
  }
  const splits = enriched.points?.length >= 2
    ? computeSplits(enriched.points, { unit: freshState.unit })
    : (baseTrack.splits || activity?.splits || [])
  const updatedTrack = { ...baseTrack, ...enriched, splits }
  const trackPath = resolveTrackPath(activity) || `${activity.id}.json`
  await writeTrack(trackPath, updatedTrack)
  const patch = {
    elevationGainM: enriched.elevationGainM ?? enriched.gain,
    splits,
  }
  if (typeof updateCardioActivity === 'function' && activity?.id) {
    updateCardioActivity(activity.id, patch)
  }
  if (isServerMode && activity?.id) {
    try {
      await api(`/api/tracks/${encodeURIComponent(activity.id)}`, {
        method: 'PUT',
        body: JSON.stringify(updatedTrack),
      })
    } catch (serverErr) {
      console.warn('Server track sync failed:', serverErr)
    }
  }
  return { updatedTrack, patch }
}

export default function ActivityDetail({
  id: propId,
  activityId: propActivityId,
  activity: propActivity,
  onBack,
  initialTrimMode = false,
}) {
  let routerParams = {}
  try {
    routerParams = useParams() || {}
  } catch {}
  let navigate = null
  try {
    navigate = useNavigate()
  } catch {}

  const targetId = propId || propActivityId || propActivity?.id || routerParams?.id
  const S = useStore(s => s.S) || {}
  const updateCardioActivity = useStore(s => s.updateCardioActivity)
  const user = useStore(s => s.user)
  const isServerModeFn = useStore(s => s.isServerMode)
  const isServerMode = Boolean(isServerModeFn ? isServerModeFn() : user)

  const cardioActivities = S.cardioActivities || []
  const storeActivity = cardioActivities.find(a => String(a.id) === String(targetId))
  const [activity, setActivity] = useState(propActivity || storeActivity || { id: targetId })

  // Synchronize with prop or store changes
  useEffect(() => {
    if (propActivity) {
      setActivity(propActivity)
    } else if (storeActivity) {
      setActivity(storeActivity)
    }
  }, [propActivity, storeActivity])

  // Track data state
  const initialTrack = activity.track || activity.points ? activity : null
  const initialPoints = Array.isArray(activity.points)
    ? activity.points
    : Array.isArray(activity.track?.points)
      ? activity.track.points
      : Array.isArray(activity.track)
        ? activity.track
        : Array.isArray(activity.coordinates)
          ? activity.coordinates
          : []
  const [trackData, setTrackData] = useState(initialTrack)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Synchronized hover state (cursor across charts and map)
  const [hoverIndex, setHoverIndex] = useState(null)
  const [hoverPoint, setHoverPoint] = useState(null)

  // Trimming UI state
  const [trimMode, setTrimMode] = useState(Boolean(initialTrimMode))
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(Math.max(0, initialPoints.length - 1))
  const [savingTrim, setSavingTrim] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [savingRoute, setSavingRoute] = useState(false)
  const [correctingElevation, setCorrectingElevation] = useState(false)

  // Load track points from adapter / server if not already present
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (trackData && (Array.isArray(trackData.points) || Array.isArray(trackData))) return
      if (!activity?.id) return

      setLoading(true)
      setError(null)
      try {
        let loaded = null
        try {
          loaded = await lazyFetchTrack(activity)
        } catch {}

        if (!loaded) {
          const adapter = getCardioAdapter()
          const path = resolveTrackPath(activity) || (activity.id ? `${activity.id}.json` : '')
          if (path && adapter && typeof adapter.readTrack === 'function') {
            loaded = await adapter.readTrack(path)
          }
        }

        if (!cancelled && loaded) {
          setTrackData(loaded)
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load track')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [activity?.id])

  // Normalize track points array
  const trackPoints = useMemo(() => {
    if (!trackData) {
      if (Array.isArray(activity.points)) return activity.points
      if (activity.track && Array.isArray(activity.track.points)) return activity.track.points
      return []
    }
    if (Array.isArray(trackData)) return trackData
    if (Array.isArray(trackData.points)) return trackData.points
    if (Array.isArray(trackData.coordinates)) return trackData.coordinates
    return []
  }, [trackData, activity])

  // Reset trimming boundaries when points are loaded or change
  useEffect(() => {
    if (trackPoints.length > 0) {
      setTrimStart(0)
      setTrimEnd(trackPoints.length - 1)
    }
  }, [trackPoints.length])

  // Personal Records
  const prs = useMemo(() => {
    if (Array.isArray(activity.prs) && activity.prs.length > 0) {
      return activity.prs
    }
    try {
      return detectActivityPRs(
        { ...activity, points: trackPoints },
        cardioActivities
      )
    } catch {
      return []
    }
  }, [activity, trackPoints, cardioActivities])

  // Per-unit splits
  const splits = useMemo(() => {
    if (Array.isArray(trackData?.splits) && trackData.splits.length > 0) {
      return trackData.splits
    }
    if (Array.isArray(activity.splits) && activity.splits.length > 0) {
      return activity.splits
    }
    if (trackPoints.length >= 2) {
      try {
        return computeSplits(trackPoints, { unit: S.unit })
      } catch {
        return []
      }
    }
    return []
  }, [trackData, activity, trackPoints, S.unit])

  // Identify fastest split
  const fastestSplitIndex = useMemo(() => {
    if (!splits || splits.length === 0) return -1
    let bestIdx = -1
    let bestPace = Infinity
    for (let i = 0; i < splits.length; i++) {
      const s = splits[i]
      const p = Number(s.pace)
      if (p > 0 && p < bestPace) {
        bestPace = p
        bestIdx = i
      }
    }
    return bestIdx
  }, [splits])

  // Chart data derivation
  const chartData = useMemo(() => {
    if (!trackPoints || trackPoints.length < 2) return []
    const valid = trackPoints.filter(isValidPoint)
    if (valid.length < 2) return []

    let cum = 0
    const distances = [0]
    for (let i = 1; i < valid.length; i++) {
      cum += haversineDistance(valid[i - 1], valid[i])
      distances.push(cum)
    }

    const smoothed = smoothElevation(valid, { windowSize: Math.min(5, valid.length) })
    const elevations = smoothed.map(p => getPointEle(p) ?? 0)
    const paces = rollingPace(valid, { unit: S.unit, windowSeconds: 15 })

    return valid.map((p, idx) => ({
      index: idx,
      point: p,
      cumDist: distances[idx],
      ele: elevations[idx],
      pace: paces[idx] || 0,
    }))
  }, [trackPoints, S.unit])

  // Chart range calculations
  const totalTrackDist = chartData.length > 0 ? chartData[chartData.length - 1].cumDist : 0
  const totalDist = totalTrackDist > 0 ? totalTrackDist : (activity.distanceM || 0)

  const eleValues = chartData.map(d => d.ele)
  const minEle = eleValues.length > 0 ? Math.min(...eleValues) : 0
  const maxEle = eleValues.length > 0 ? Math.max(...eleValues) : 100
  const eleSpan = Math.max(1, maxEle - minEle)

  // Filter positive paces for meaningful bounds
  const validPaces = chartData.map(d => d.pace).filter(p => p > 1 && p < 30)
  const minPace = validPaces.length > 0 ? Math.min(...validPaces) : 3
  const maxPace = validPaces.length > 0 ? Math.max(...validPaces) : 10
  const paceSpan = Math.max(0.5, maxPace - minPace)

  // Coordinate projection helpers
  const getX = dist => {
    if (totalDist <= 0) return P.l
    return P.l + (dist / totalDist) * (CHART_W - P.l - P.r)
  }

  const getEleY = ele => {
    const f = (ele - minEle) / eleSpan
    return CHART_H - P.b - f * (CHART_H - P.t - P.b)
  }

  // Pace: runners prefer faster pace (smaller min/km) toward top
  const getPaceY = pace => {
    const clamped = Math.max(minPace, Math.min(maxPace, pace || maxPace))
    const f = (clamped - minPace) / paceSpan
    return P.t + f * (CHART_H - P.t - P.b)
  }

  // Pointer hover handler synchronized across charts
  const handleChartPointerMove = e => {
    if (!chartData || chartData.length < 2) return
    const svgNode = e.currentTarget
    const rect = svgNode.getBoundingClientRect()
    const clientX = e.clientX ?? (e.touches ? e.touches[0].clientX : null)
    if (clientX == null) return

    const usableW = rect.width * ((CHART_W - P.l - P.r) / CHART_W)
    const offsetX = clientX - rect.left - (rect.width * (P.l / CHART_W))
    const ratio = Math.max(0, Math.min(1, offsetX / usableW))
    const targetDist = ratio * totalDist

    let closest = 0
    let minDiff = Infinity
    for (let i = 0; i < chartData.length; i++) {
      const diff = Math.abs(chartData[i].cumDist - targetDist)
      if (diff < minDiff) {
        minDiff = diff
        closest = i
      }
    }

    setHoverIndex(closest)
    setHoverPoint(chartData[closest].point)
  }

  const handleChartPointerLeave = () => {
    setHoverIndex(null)
    setHoverPoint(null)
  }

  // Navigation back
  const handleBack = () => {
    if (typeof onBack === 'function') {
      onBack()
    } else if (navigate) {
      navigate(-1)
    } else if (typeof window !== 'undefined' && window.history) {
      window.history.back()
    }
  }

  // GPX Export handler
  const handleExportGPX = async () => {
    setExporting(true)
    try {
      const sportName = activity.cardioType || activity.type || activity.sport || 'activity'
      const baseName = sanitizeFilename(activity.name || sportName)
      const filename = `${baseName}-${activity.id || Date.now()}.gpx`
      await exportGPX(
        {
          ...activity,
          points: trackPoints,
        },
        {
          filename,
          name: activity.name || `${sportName.toUpperCase()} Activity`,
        }
      )
      useUI.getState().toast?.(t('GPX exported'))
    } catch (err) {
      useUI.getState().toast?.(t('Export failed'))
    } finally {
      setExporting(false)
    }
  }

  // Save Track Trim handler
  const handleSaveTrim = async () => {
    if (trimStart < 0 || trimEnd >= trackPoints.length || trimStart > trimEnd) return
    setSavingTrim(true)
    try {
      const trimmed = trimTrackPoints(
        trackData || { ...activity, points: trackPoints },
        trimStart,
        trimEnd,
        {
          unit: S.unit,
          activity: activity.cardioType || activity.type || 'run',
        }
      )

      const trackPath = resolveTrackPath(activity) || `${activity.id}.json`
      await writeTrack(trackPath, trimmed)

      const patch = {
        distanceM: trimmed.distanceM,
        durationMs: trimmed.durationMs,
        avgPaceSecKm: trimmed.avgPace != null && trimmed.distanceM > 0
          ? trimmed.durationMs / trimmed.distanceM
          : null,
        avgSpeedKmh: trimmed.avgSpeed != null && trimmed.durationMs > 0
          ? (trimmed.distanceM * 3600) / trimmed.durationMs
          : null,
        elevationGainM: trimmed.elevationGainM,
        splits: trimmed.splits,
      }

      if (typeof updateCardioActivity === 'function') {
        updateCardioActivity(activity.id, patch)
      }

      if (isServerMode) {
        try {
          await api(`/api/tracks/${encodeURIComponent(activity.id)}`, {
            method: 'PUT',
            body: JSON.stringify(trimmed),
          })
        } catch (serverErr) {
          console.warn('Server track sync failed:', serverErr)
        }
      }

      const updatedActivity = {
        ...activity,
        ...patch,
        track: trimmed,
        points: trimmed.points,
      }
      setActivity(updatedActivity)
      setTrackData(trimmed)
      setTrimMode(false)
      useUI.getState().toast?.(t('Track trimmed successfully'))
    } catch (err) {
      useUI.getState().toast?.(t('Failed to trim track'))
    } finally {
      setSavingTrim(false)
    }
  }

  const handleEdit = () => {
    if (!activity?.id) return
    openManualCardioSheet(
      {
        ...activity,
        type: activity.cardioType || activity.type || activity.sport || 'run',
        startTime: activity.startTime || activity.d,
      },
      {
        onSave: saved => {
          if (saved) setActivity(prev => ({ ...prev, ...saved }))
        },
        onDelete: () => handleBack(),
      }
    )
  }

  const handleSaveAsRoute = async () => {
    if (savingRoute || trackPoints.length === 0) return
    setSavingRoute(true)
    try {
      await saveActivityAsRoute(activity, trackPoints, {
        isServerMode,
        nameFallback: t(activity.cardioType || activity.type || 'Cardio'),
      })
      useUI.getState().toast?.(t('Saved as route'))
    } catch (err) {
      useUI.getState().toast?.(t('Failed to save route'))
    } finally {
      setSavingRoute(false)
    }
  }

  const runElevationCorrection = async () => {
    if (correctingElevation || trackPoints.length === 0) return
    setCorrectingElevation(true)
    try {
      const freshState = useStore.getState()?.S || S
      const res = await correctActivityElevation(activity, trackData, trackPoints, {
        state: freshState,
        updateCardioActivity,
        isServerMode,
      })
      if (res?.unavailable) {
        useUI.getState().toast?.(t('Elevation data unavailable'))
        return
      }
      if (res?.updatedTrack) {
        setTrackData(res.updatedTrack)
        setActivity(prev => ({
          ...prev,
          ...res.patch,
          track: res.updatedTrack,
          points: res.updatedTrack.points,
        }))
        useUI.getState().toast?.(t('Elevation corrected'))
      }
    } catch (err) {
      useUI.getState().toast?.(t('Failed to correct elevation'))
    } finally {
      setCorrectingElevation(false)
    }
  }

  const handleCorrectElevation = () => {
    if (correctingElevation || trackPoints.length === 0) return
    const currentState = useStore.getState()?.S || S
    if (!hasElevationConsent(currentState)) {
      const feat = EXTERNAL_FEATURES.find(f => f.id === ELEVATION_FEATURE_ID)
      openConsentSheet(feat, { onAgree: () => { runElevationCorrection() } })
      return
    }
    runElevationCorrection()
  }

  // Active hover details
  const activeHover = hoverIndex != null && chartData[hoverIndex] ? chartData[hoverIndex] : null
  const hoverX = activeHover ? getX(activeHover.cumDist) : null
  const hoverEleY = activeHover ? getEleY(activeHover.ele) : null
  const hoverPaceY = activeHover ? getPaceY(activeHover.pace) : null

  // Rate badge for summary
  const metric = defaultRateMetric(activity.cardioType || activity.type || 'run')
  const rateDisplay = metric === 'speed'
    ? (activity.avgSpeedKmh ? formatSpeed(activity.avgSpeedKmh, S.unit) : null)
    : (fmtPaceSec(activity.avgPaceSecKm, S.unit) || null)
  const dateLabel = fmtDate(activity.d, true) || fmtDate(activity.startTime, true)
  const activityNotes = activity?.notes != null ? String(activity.notes).trim() : ''

  return (
    <div
      className="activity-detail-view"
      data-testid="activity-detail-view"
      style={{ maxWidth: 720, margin: '0 auto', paddingBottom: 'calc(32px + var(--sab))' }}
    >
      {/* Navigation header */}
      <div
        className="row between activity-detail-topbar"
        style={{ alignItems: 'center', gap: 8, marginBottom: 12 }}
      >
        <button
          type="button"
          className="iconbtn"
          onClick={handleBack}
          aria-label={t('Back')}
          data-testid="back-btn"
        >
          <Icon name="chevronLeft" />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button
            type="button"
            variant="plain"
            size="sm"
            icon="pencil"
            onClick={handleEdit}
            disabled={!activity?.id}
            data-testid="edit-activity-btn"
            style={{ minHeight: 36, fontSize: 13, padding: '6px 10px' }}
          >
            {t('Edit')}
          </Button>

          <Button
            type="button"
            variant="plain"
            size="sm"
            icon="download"
            onClick={handleExportGPX}
            disabled={exporting || trackPoints.length === 0}
            data-testid="gpx-export-btn"
            style={{ minHeight: 36, fontSize: 13, padding: '6px 10px' }}
          >
            {t('Export GPX')}
          </Button>
        </div>
      </div>

      {/* Activity Title & PR Trophies */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 24, textTransform: 'capitalize' }} data-testid="activity-title">
            {activity.name || t(activity.cardioType || activity.type || 'Cardio')}
          </h1>
          {dateLabel && (
            <span style={{ color: 'var(--label-2)', fontSize: 14 }} data-testid="activity-date">
              {dateLabel}
            </span>
          )}
        </div>

        {prs.length > 0 && (
          <div style={{ marginTop: 8 }} data-testid="activity-pr-badges">
            <ActivityPrBadges prs={prs} max={5} />
          </div>
        )}
      </div>

      {/* Track Actions */}
      {trackPoints.length > 0 && (
        <div
          className="activity-track-actions"
          style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}
        >
          <Button
            type="button"
            variant="tinted"
            size="sm"
            icon="link"
            onClick={handleSaveAsRoute}
            disabled={savingRoute}
            data-testid="save-route-btn"
            style={{ minHeight: 36, fontSize: 13, padding: '6px 10px' }}
          >
            {savingRoute ? t('Saving route…') : t('Save as Route')}
          </Button>

          <Button
            type="button"
            variant="tinted"
            size="sm"
            icon="arrowUp"
            onClick={handleCorrectElevation}
            disabled={correctingElevation}
            data-testid="correct-elevation-btn"
            style={{ minHeight: 36, fontSize: 13, padding: '6px 10px' }}
          >
            {correctingElevation ? t('Correcting…') : t('Correct Elevation')}
          </Button>

          {trackPoints.length >= 2 && (
            <Button
              type="button"
              variant={trimMode ? 'primary' : 'tinted'}
              size="sm"
              icon="pencil"
              onClick={() => setTrimMode(!trimMode)}
              data-testid="trim-toggle-btn"
              style={{ minHeight: 36, fontSize: 13, padding: '6px 10px' }}
            >
              {t('Trim')}
            </Button>
          )}
        </div>
      )}

      {/* Summary KPI Cards */}
      <div
        className="activity-kpi-grid"
        data-testid="activity-kpi-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 10,
          marginBottom: 20,
        }}
      >
        <div className="card" style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface)' }}>
          <div style={{ fontSize: 12, color: 'var(--label-2)' }}>{t('Distance')}</div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }} data-testid="kpi-distance">
            {activity.distanceM > 0 ? fmtDist(activity.distanceM, S.unit) : '—'}
          </div>
        </div>

        <div className="card" style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface)' }}>
          <div style={{ fontSize: 12, color: 'var(--label-2)' }}>{t('Duration')}</div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }} data-testid="kpi-duration">
            {fmtDur(activity.durationMs || 0)}
          </div>
        </div>

        {rateDisplay && (
          <div className="card" style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface)' }}>
            <div style={{ fontSize: 12, color: 'var(--label-2)' }}>{metric === 'speed' ? t('Avg Speed') : t('Avg Pace')}</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }} data-testid="kpi-rate">
              {rateDisplay}
            </div>
          </div>
        )}

        {activity.elevationGainM != null && (
          <div className="card" style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface)' }}>
            <div style={{ fontSize: 12, color: 'var(--label-2)' }}>{t('Elevation Gain')}</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }} data-testid="kpi-elevation">
              +{formatElevation(activity.elevationGainM, S.unit)}
            </div>
          </div>
        )}
      </div>

      {activityNotes && (
        <div className="card" data-testid="activity-notes" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--label-2)', marginBottom: 4 }}>{t('Notes')}</div>
          <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{activityNotes}</div>
        </div>
      )}

      {/* Start/End Trimming UI */}
      {trimMode && (
        <div
          className="trim-controls card"
          data-testid="trim-controls"
          style={{
            padding: 16,
            borderRadius: 10,
            border: '1px solid var(--acc)',
            marginBottom: 20,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>{t('Trim Track Points')}</h3>
            <span style={{ fontSize: 12, color: 'var(--label-2)' }} data-testid="trim-points-count">
              {Math.max(0, trimEnd - trimStart + 1)} / {trackPoints.length} {t('points')}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span>{t('Start Point')}</span>
                <span data-testid="trim-start-value">#{trimStart}</span>
              </div>
              <Slider
                min={0}
                max={Math.max(0, trackPoints.length - 1)}
                step={1}
                value={trimStart}
                onChange={val => setTrimStart(Math.min(val, trimEnd))}
                aria-label={t('Start Point')}
                data-testid="trim-start-slider"
              />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span>{t('End Point')}</span>
                <span data-testid="trim-end-value">#{trimEnd}</span>
              </div>
              <Slider
                min={0}
                max={Math.max(0, trackPoints.length - 1)}
                step={1}
                value={trimEnd}
                onChange={val => setTrimEnd(Math.max(val, trimStart))}
                aria-label={t('End Point')}
                data-testid="trim-end-slider"
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <Button
                type="button"
                variant="plain"
                size="sm"
                onClick={() => {
                  setTrimStart(0)
                  setTrimEnd(trackPoints.length - 1)
                  setTrimMode(false)
                }}
                data-testid="trim-cancel-btn"
                style={{ minHeight: 36 }}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={handleSaveTrim}
                disabled={savingTrim}
                data-testid="trim-save-btn"
                style={{ minHeight: 36 }}
              >
                {savingTrim ? t('Saving…') : t('Save Trim')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* GPS Route Map with synchronized hover cursor */}
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 16, marginBottom: 8 }}>{t('Route Map')}</h3>
        {trackPoints.length > 0 ? (
          <div style={{ borderRadius: 10, overflow: 'hidden' }}>
            <RouteMap
              points={trackPoints}
              currentPosition={hoverPoint}
              state={S}
              width="100%"
              height={260}
              dataTestId="activity-route-map"
            />
          </div>
        ) : (
          <div className="card empty" style={{ padding: 24, textAlign: 'center', color: 'var(--label-3)' }}>
            {loading ? t('Loading route track…') : error || t('No GPS track data available for this activity.')}
          </div>
        )}
      </div>

      {/* Interactive Pace & Elevation Profile Charts */}
      {chartData.length >= 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginBottom: 24 }}>
          {/* Elevation Profile Chart */}
          <div className="card" style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--surface)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t('Elevation Profile')}</span>
              {activeHover ? (
                <span style={{ fontSize: 12, color: 'var(--blue)' }} data-testid="elevation-hover-tooltip">
                  {formatElevation(activeHover.ele, S.unit)} · {formatDistance(activeHover.cumDist, S.unit)}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--label-2)' }}>
                  +{formatElevation(maxEle - minEle, S.unit)} {t('range')}
                </span>
              )}
            </div>

            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible', cursor: 'crosshair' }}
              onMouseMove={handleChartPointerMove}
              onTouchMove={handleChartPointerMove}
              onMouseLeave={handleChartPointerLeave}
              onTouchEnd={handleChartPointerLeave}
              data-testid="elevation-chart"
            >
              <defs>
                <linearGradient id="eleGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--blue)" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="var(--blue)" stopOpacity="0.02" />
                </linearGradient>
              </defs>

              {/* Gridlines & Y-axis labels */}
              <line x1={P.l} y1={P.t} x2={CHART_W - P.r} y2={P.t} stroke="var(--sep-op)" strokeDasharray="2 4" />
              <text x={P.l - 6} y={P.t + 4} textAnchor="end" fontSize="9.5" fill="var(--label-2)">
                {Math.round(maxEle)}
              </text>

              <line x1={P.l} y1={CHART_H - P.b} x2={CHART_W - P.r} y2={CHART_H - P.b} stroke="var(--sep-op)" />
              <text x={P.l - 6} y={CHART_H - P.b + 3} textAnchor="end" fontSize="9.5" fill="var(--label-2)">
                {Math.round(minEle)} {elevationUnit(S.unit)}
              </text>

              {/* Distance X-axis labels */}
              <text x={P.l} y={CHART_H - 8} textAnchor="start" fontSize="9.5" fill="var(--label-2)">
                0
              </text>
              <text x={CHART_W - P.r} y={CHART_H - 8} textAnchor="end" fontSize="9.5" fill="var(--label-2)">
                {formatDistance(totalDist, S.unit)}
              </text>

              {/* Elevation filled area */}
              {chartData.length > 1 && (
                <path
                  d={`M ${getX(chartData[0].cumDist)} ${CHART_H - P.b} ` +
                    chartData.map(d => `L ${getX(d.cumDist)} ${getEleY(d.ele)}`).join(' ') +
                    ` L ${getX(chartData[chartData.length - 1].cumDist)} ${CHART_H - P.b} Z`}
                  fill="url(#eleGrad)"
                />
              )}

              {/* Elevation stroke curve */}
              {chartData.length > 1 && (
                <path
                  d={chartData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(d.cumDist)} ${getEleY(d.ele)}`).join(' ')}
                  fill="none"
                  stroke="var(--blue)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {/* Synchronized Hover Cursor */}
              {hoverX != null && hoverEleY != null && (
                <g data-testid="elevation-chart-cursor">
                  <line
                    x1={hoverX}
                    y1={P.t}
                    x2={hoverX}
                    y2={CHART_H - P.b}
                    stroke="var(--blue)"
                    strokeWidth="1.5"
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={hoverX}
                    cy={hoverEleY}
                    r="4.5"
                    fill="var(--blue)"
                    stroke="#ffffff" /* literal: SVG presentation attributes cannot resolve var() */
                    strokeWidth="2"
                  />
                </g>
              )}
            </svg>
          </div>

          {/* Interactive Pace Chart */}
          <div className="card" style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--surface)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{t('Pace Chart')}</span>
              {activeHover ? (
                <span style={{ fontSize: 12, color: 'var(--acc)' }} data-testid="pace-hover-tooltip">
                  {fmtPace(activeHover.pace, S.unit)} · {formatDistance(activeHover.cumDist, S.unit)}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--label-2)' }}>
                  {paceUnit(S.unit)}
                </span>
              )}
            </div>

            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible', cursor: 'crosshair' }}
              onMouseMove={handleChartPointerMove}
              onTouchMove={handleChartPointerMove}
              onMouseLeave={handleChartPointerLeave}
              onTouchEnd={handleChartPointerLeave}
              data-testid="pace-chart"
            >
              {/* Pace Gridlines & Labels */}
              <line x1={P.l} y1={P.t} x2={CHART_W - P.r} y2={P.t} stroke="var(--sep-op)" strokeDasharray="2 4" />
              <text x={P.l - 6} y={P.t + 4} textAnchor="end" fontSize="9.5" fill="var(--label-2)">
                {fmtPace(minPace, S.unit, { short: true })}
              </text>

              <line x1={P.l} y1={CHART_H - P.b} x2={CHART_W - P.r} y2={CHART_H - P.b} stroke="var(--sep-op)" />
              <text x={P.l - 6} y={CHART_H - P.b + 3} textAnchor="end" fontSize="9.5" fill="var(--label-2)">
                {fmtPace(maxPace, S.unit, { short: true })}
              </text>

              {/* Distance X-axis labels */}
              <text x={P.l} y={CHART_H - 8} textAnchor="start" fontSize="9.5" fill="var(--label-2)">
                0
              </text>
              <text x={CHART_W - P.r} y={CHART_H - 8} textAnchor="end" fontSize="9.5" fill="var(--label-2)">
                {formatDistance(totalDist, S.unit)}
              </text>

              {/* Pace curve */}
              {chartData.length > 1 && (
                <path
                  d={chartData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(d.cumDist)} ${getPaceY(d.pace)}`).join(' ')}
                  fill="none"
                  stroke="var(--acc)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {/* Synchronized Hover Cursor */}
              {hoverX != null && hoverPaceY != null && (
                <g data-testid="pace-chart-cursor">
                  <line
                    x1={hoverX}
                    y1={P.t}
                    x2={hoverX}
                    y2={CHART_H - P.b}
                    stroke="var(--acc)"
                    strokeWidth="1.5"
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={hoverX}
                    cy={hoverPaceY}
                    r="4.5"
                    fill="var(--acc)"
                    stroke="#ffffff" /* literal: SVG presentation attributes cannot resolve var() */
                    strokeWidth="2"
                  />
                </g>
              )}
            </svg>
          </div>
        </div>
      )}

      {/* Per-Unit Splits Table */}
      {splits.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 16, marginBottom: 8 }}>
            {t('Splits ({0})', distanceUnit(S.unit))}
          </h3>
          <div
            className="card"
            data-testid="splits-table"
            style={{
              padding: 0,
              borderRadius: 10,
              overflow: 'hidden',
              background: 'var(--surface)',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--sep-op)', color: 'var(--label-2)' }}>
                  <th style={{ padding: '10px 12px', width: 40 }}>#</th>
                  <th style={{ padding: '10px 12px' }}>{t('Distance')}</th>
                  <th style={{ padding: '10px 12px' }}>{t('Pace')}</th>
                  <th style={{ padding: '10px 12px' }}>{t('Time')}</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>{t('Elev Diff')}</th>
                </tr>
              </thead>
              <tbody>
                {splits.map((s, idx) => {
                  const isFastest = idx === fastestSplitIndex
                  const splitNum = s.split ?? s.splitIndex ?? idx + 1
                  const elevDiff = (s.elevationGain || 0) - (s.elevationLoss || 0)
                  return (
                    <tr
                      key={splitNum}
                      data-testid={`split-row-${splitNum}`}
                      style={{
                        borderBottom: idx < splits.length - 1 ? '1px solid var(--sep-op)' : 'none',
                        background: isFastest ? 'color-mix(in srgb, var(--acc) 12%, transparent)' : 'transparent',
                      }}
                    >
                      <td style={{ padding: '10px 12px', fontWeight: 600 }}>{splitNum}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {formatDistance(s.distance, S.unit)}
                        {s.isPartial && <span style={{ fontSize: 11, color: 'var(--label-3)', marginLeft: 4 }}>({t('partial')})</span>}
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: isFastest ? 700 : 400 }}>
                        {fmtPace(s.pace, S.unit)}
                        {isFastest && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              color: 'var(--acc)',
                              border: '1px solid currentColor',
                              borderRadius: 4,
                              padding: '1px 4px',
                            }}
                          >
                            {t('Fastest')}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px', color: 'var(--label-2)' }}>
                        {formatSplitTime(s.elapsedTime || s.movingTime)}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: elevDiff >= 0 ? 'var(--blue)' : 'var(--label-2)' }}>
                        {elevDiff >= 0 ? `+${Math.round(elevDiff)}` : `${Math.round(elevDiff)}`} {elevationUnit(S.unit)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
