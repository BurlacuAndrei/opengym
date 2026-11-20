import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import {
  createFlowPlayer,
  startActiveFlow,
  getActiveFlow,
  clearActiveFlow,
} from '../lib/flow-player.js'
import { logFreestyleSession, calculateFreestyleLoad } from '../lib/freestyle-session.js'
import { ROUTINE_KIND_LABELS, ROUTINE_KIND_ICONS, getRoutineKind } from '../lib/routine-kind.js'
import { useWakeLock } from '../lib/wakelock.js'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import Media from '../components/Media.jsx'
import { Button } from '../components/ui.jsx'

/**
 * Custom hook to bind FlowPlayer engine to React lifecycle via the shared active-flow controller.
 *
 * @param {Object} routine - Routine to play
 * @param {Object} [options={}] - Player options
 * @returns {{ state: Object, player: Object, startedAtRef: Object }}
 */
export function useFlowPlayer(routine, options = {}) {
  const S = useStore(s => s.S)
  const voiceCues = options.voiceCues !== undefined ? options.voiceCues : S.voiceCues !== false
  const playerRef = useRef(null)
  const startedAtRef = useRef(null)
  const routineRef = useRef(routine)
  routineRef.current = routine
  const optionsRef = useRef(options)
  optionsRef.current = { ...options, voiceCues }
  const routineId = routine?.id ?? null
  const hasExercises = Boolean(routine && Array.isArray(routine.ex) && routine.ex.length > 0)
  const completedRef = useRef(false)
  const activeRoutineIdRef = useRef(routineId)

  if (activeRoutineIdRef.current !== routineId) {
    activeRoutineIdRef.current = routineId
    completedRef.current = false
  }

  const [state, setState] = useState(() => {
    const active = getActiveFlow()
    if (
      active &&
      routine &&
      ((active.routineId && active.routineId === routine.id) ||
        (!active.routineId && active.routine === routine))
    ) {
      playerRef.current = active.player
      startedAtRef.current = active.startedAt
      return active.player.getState()
    }
    const p = createFlowPlayer(routine, { ...options, voiceCues, autoStart: false })
    return p.getState()
  })

  useEffect(() => {
    const curRoutine = routineRef.current
    if (!curRoutine || !Array.isArray(curRoutine.ex) || curRoutine.ex.length === 0) {
      playerRef.current = null
      return
    }
    if (completedRef.current || optionsRef.current.completed) {
      return
    }
    const opts = optionsRef.current
    const flow = startActiveFlow(curRoutine, {
      ...opts,
      autoStart: opts.autoStart !== false,
    })
    if (!flow) return
    playerRef.current = flow.player
    startedAtRef.current = flow.startedAt
    setState(flow.player.getState())

    const unsubscribe = flow.player.subscribe(updated => {
      if (updated.isCompleted) {
        completedRef.current = true
      }
      setState(updated)
    })

    return () => {
      unsubscribe()
    }
  }, [routineId, hasExercises])

  return {
    state,
    player: playerRef.current,
    playerRef,
    startedAtRef,
  }
}

/**
 * Formats a duration in seconds to M:SS.
 */
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(s / 60)
  const rem = s % 60
  return `${mins}:${String(rem).padStart(2, '0')}`
}

/**
 * Persists a completed Flow Session into S.freestyleSessions and clears active flow.
 */
export function persistFlowCompletion({ routine, kind, totalElapsed = 0, rpe = 6, startedAt } = {}) {
  const durationMs = Math.max(1000, Math.round((totalElapsed || 0) * 1000))
  const saved = logFreestyleSession({
    kind,
    durationMs,
    rpe,
    routineId: routine?.id || undefined,
    name: routine?.name || undefined,
    startTime: new Date(startedAt || Date.now()).toISOString(),
  })
  clearActiveFlow()
  return saved
}

/**
 * FlowPlayer component for HIIT, Yoga, and Mobility sessions.
 */
export default function FlowPlayer({ routine: propRoutine, onFinish, onClose }) {
  const nav = useNavigate()
  const { id } = useParams()
  const location = useLocation()
  const S = useStore(s => s.S)

  // Resolve routine from props, location state, store, or active flow
  const routine = useMemo(() => {
    if (propRoutine) return propRoutine
    if (location.state?.routine) return location.state.routine
    if (id) {
      const found = S.routines.find(r => r.id === id)
      if (found) return found
      const active = getActiveFlow()
      if (active?.routineId === id) return active.routine
    }
    return null
  }, [propRoutine, location.state, id, S.routines])

  const kind = routine ? getRoutineKind(routine) : 'yoga'
  const kindLabel = ROUTINE_KIND_LABELS[kind] || 'Flow'
  const kindIcon = ROUTINE_KIND_ICONS[kind] || 'sparkles'

  const routineId = routine?.id ?? null
  const persistedPlayerRef = useRef(null)
  const [completedSummary, setCompletedSummary] = useState(null)
  const activeCompletedSummary =
    completedSummary && completedSummary.routineId === routineId ? completedSummary : null
  const [rpe, setRpe] = useState(6)

  const { state, player, playerRef, startedAtRef } = useFlowPlayer(routine, {
    autoStart: true,
    voiceCues: S.voiceCues !== false,
    completed: Boolean(activeCompletedSummary),
  })

  useEffect(() => {
    if (
      !state.isCompleted ||
      !routine?.ex?.length ||
      !playerRef.current ||
      persistedPlayerRef.current === playerRef.current
    ) {
      return
    }
    persistedPlayerRef.current = playerRef.current
    const saved = persistFlowCompletion({
      routine,
      kind,
      totalElapsed: state.totalElapsed,
      rpe,
      startedAt: startedAtRef.current,
    })
    setCompletedSummary({
      routineId,
      sessionId: saved.id,
      totalMoves: state.totalMoves,
      totalElapsed: state.totalElapsed,
      durationMs: saved.durationMs,
    })
  }, [state.isCompleted, state.totalMoves, state.totalElapsed, routine, routineId, kind, rpe, playerRef, startedAtRef])

  const handleRpeChange = useCallback(val => {
    setRpe(val)
    if (activeCompletedSummary?.sessionId) {
      useStore.getState().update(s => {
        const rec = (s.freestyleSessions || []).find(x => x.id === activeCompletedSummary.sessionId)
        if (rec) {
          rec.rpe = val
          rec.load = calculateFreestyleLoad({ durationMs: rec.durationMs, rpe: val })
        }
      })
    }
  }, [activeCompletedSummary])

  const handleFinish = useCallback(() => {
    clearActiveFlow()
    if (onFinish) {
      onFinish()
    } else {
      nav('/home')
    }
  }, [onFinish, nav])

  const handleClose = useCallback(() => {
    clearActiveFlow()
    if (onClose) {
      onClose()
    } else {
      nav('/home')
    }
  }, [onClose, nav])

  useWakeLock(state.isPlaying)

  if (!routine || !routine.ex?.length) {
    return (
      <div className="narrow" style={{ padding: '24px 16px', textAlign: 'center' }}>
        <h2>{t('No exercises in this routine')}</h2>
        <p className="dim" style={{ margin: '12px 0 24px' }}>
          {t('Add exercises to this routine before starting flow mode.')}
        </p>
        <Button variant="primary" onClick={handleClose}>{t('Back')}</Button>
      </div>
    )
  }

  const {
    currentMove,
    nextMove,
    timeRemaining,
    currentIndex,
    totalMoves,
    isPlaying,
    isPaused,
    isCompleted,
    totalElapsed,
  } = state

  if (activeCompletedSummary || isCompleted) {
    const doneMoves = activeCompletedSummary?.totalMoves ?? totalMoves
    const doneElapsed = activeCompletedSummary?.totalElapsed ?? totalElapsed
    return (
      <div className="narrow" style={{ padding: '32px 16px', textAlign: 'center' }}>
        <div style={{ color: 'var(--acc)', fontSize: 56, marginBottom: 16 }}>
          <Icon name="checkCircle" />
        </div>
        <h1>{t('Flow complete!')}</h1>
        <p className="dim" style={{ margin: '8px 0 20px', fontSize: 16 }}>
          {t('Completed {0} moves in {1}.', doneMoves, formatTime(doneElapsed))}
        </p>
        {activeCompletedSummary && (
          <div style={{ marginBottom: 24, textAlign: 'left' }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <label className="muted small">{t('Rate of Perceived Exertion (sRPE 1-10)')}</label>
              <span className="small accent" style={{ fontWeight: 600 }}>{rpe}/10</span>
            </div>
            <div className="chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(val => (
                <button
                  key={val}
                  type="button"
                  className={`chip ${rpe === val ? 'on' : ''}`}
                  style={{ minWidth: 32, textAlign: 'center' }}
                  onClick={() => handleRpeChange(val)}
                  data-testid={`flow-rpe-chip-${val}`}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>
        )}
        <Button variant="primary" onClick={handleFinish}>{t('Done')}</Button>
      </div>
    )
  }

  const progress = totalMoves > 0 ? ((currentIndex + (1 - (timeRemaining / (currentMove?.duration || 1)))) / totalMoves) * 100 : 0

  return (
    <div className="flow-player-view" style={{ maxWidth: 520, margin: '0 auto', padding: '16px' }}>
      {/* Header bar */}
      <div className="row between" style={{ alignItems: 'center', marginBottom: 12 }}>
        <button
          className="iconbtn"
          aria-label={t('Exit flow')}
          onClick={handleClose}
          style={{ width: 36, height: 36, borderRadius: '50%' }}
        >
          <Icon name="minus" />
        </button>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>{routine.name}</div>
          <div className="row" style={{ justifyContent: 'center', gap: 4, alignItems: 'center' }}>
            <span className="tag acc" style={{ fontSize: 11, padding: '2px 8px' }}>
              <Icon name={kindIcon} style={{ fontSize: 12, marginRight: 3 }} />
              {kindLabel}
            </span>
            <span className="small dim">
              {t('Move {0} of {1}', currentIndex + 1, totalMoves)}
            </span>
          </div>
        </div>

        <div style={{ width: 36 }} />
      </div>

      {/* Progress Bar */}
      <div style={{
        height: 6,
        background: 'var(--surface-2, rgba(255,255,255,0.1))',
        borderRadius: 3,
        overflow: 'hidden',
        marginBottom: 16
      }}>
        <div style={{
          height: '100%',
          width: `${Math.min(100, Math.max(0, progress))}%`,
          background: 'var(--acc)',
          transition: 'width 0.3s ease'
        }} />
      </div>

      {/* Exercise Media */}
      {currentMove?.exercise && (
        <div style={{ marginBottom: 16, borderRadius: 12, overflow: 'hidden' }}>
          <Media ex={currentMove.exercise} />
        </div>
      )}

      {/* Current Move Title and Big Timer */}
      <div style={{ textAlign: 'center', margin: '20px 0' }}>
        <h2 style={{ fontSize: 24, textTransform: 'capitalize', marginBottom: 4 }}>
          {currentMove?.name}
        </h2>
        {currentMove?.totalSets > 1 && (
          <div className="small dim" style={{ marginBottom: 8 }}>
            {t('Set {0} of {1}', currentMove.setIndex, currentMove.totalSets)}
          </div>
        )}

        {/* Big countdown clock */}
        <div style={{
          fontSize: 64,
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          color: timeRemaining <= 3 ? 'var(--orange, #f97316)' : 'var(--acc)',
          margin: '12px 0',
          letterSpacing: -1,
        }}>
          {formatTime(timeRemaining)}
        </div>

        {/* Up next preview */}
        {nextMove ? (
          <div className="dim small" style={{ marginTop: 8 }}>
            {t('Up next: {0} ({1}s)', nextMove.name, nextMove.duration)}
          </div>
        ) : (
          <div className="dim small" style={{ marginTop: 8 }}>
            {t('Final move!')}
          </div>
        )}
      </div>

      {/* Controls: Restart, Pause/Resume, Skip */}
      <div className="row" style={{ justifyContent: 'center', gap: 20, alignItems: 'center', marginTop: 28 }}>
        <button
          className="iconbtn"
          aria-label={t('Restart move')}
          title={t('Restart move')}
          onClick={() => player?.restartMove()}
          style={{ width: 48, height: 48, borderRadius: '50%', fontSize: 20 }}
        >
          <Icon name="reset" />
        </button>

        <button
          className="btn primary"
          aria-label={isPlaying ? t('Pause') : t('Resume')}
          onClick={() => player?.togglePause()}
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
            padding: 0
          }}
        >
          <Icon name={isPaused ? 'play' : 'pause'} />
        </button>

        <button
          className="iconbtn"
          aria-label={t('Skip move')}
          title={t('Skip move')}
          onClick={() => player?.skip()}
          style={{ width: 48, height: 48, borderRadius: '50%', fontSize: 22 }}
        >
          <Icon name="chevronRight" />
        </button>
      </div>
    </div>
  )
}
