import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { createFlowPlayer, isFlowRoutine } from '../lib/flow-player.js'
import { ROUTINE_KIND_LABELS, ROUTINE_KIND_ICONS, getRoutineKind } from '../lib/routine-kind.js'
import { useWakeLock } from '../lib/wakelock.js'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import Media from '../components/Media.jsx'
import { Button } from '../components/ui.jsx'

/**
 * Custom hook to bind FlowPlayer engine to React lifecycle.
 *
 * @param {Object} routine - Routine to play
 * @param {Object} [options={}] - Player options
 * @returns {{ state: Object, player: Object }}
 */
export function useFlowPlayer(routine, options = {}) {
  const S = useStore(s => s.S)
  const voiceCues = options.voiceCues !== undefined ? options.voiceCues : S.voiceCues !== false
  const [state, setState] = useState(() => {
    const p = createFlowPlayer(routine, { ...options, voiceCues })
    return p.getState()
  })

  const playerRef = useRef(null)

  useEffect(() => {
    const p = createFlowPlayer(routine, {
      ...options,
      voiceCues,
      autoStart: options.autoStart !== false,
    })
    playerRef.current = p
    setState(p.getState())

    const unsubscribe = p.subscribe(updated => {
      setState(updated)
    })

    return () => {
      unsubscribe()
      p.destroy()
    }
  }, [routine, voiceCues])

  return {
    state,
    player: playerRef.current,
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
 * FlowPlayer component for HIIT, Yoga, and Mobility sessions.
 */
export default function FlowPlayer({ routine: propRoutine, onFinish, onClose }) {
  const nav = useNavigate()
  const { id } = useParams()
  const location = useLocation()
  const S = useStore(s => s.S)

  // Resolve routine from props, location state, or store
  const routine = useMemo(() => {
    if (propRoutine) return propRoutine
    if (location.state?.routine) return location.state.routine
    if (id) return S.routines.find(r => r.id === id)
    return null
  }, [propRoutine, location.state, id, S.routines])

  const kind = routine ? getRoutineKind(routine) : 'yoga'
  const kindLabel = ROUTINE_KIND_LABELS[kind] || 'Flow'
  const kindIcon = ROUTINE_KIND_ICONS[kind] || 'sparkles'

  const handleFinish = useCallback(() => {
    if (onFinish) {
      onFinish()
    } else {
      nav(-1)
    }
  }, [onFinish, nav])

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose()
    } else {
      nav(-1)
    }
  }, [onClose, nav])

  const { state, player } = useFlowPlayer(routine, {
    autoStart: true,
    voiceCues: S.voiceCues !== false,
    onComplete: () => {
      // Flow completed
    },
  })

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

  if (isCompleted) {
    return (
      <div className="narrow" style={{ padding: '32px 16px', textAlign: 'center' }}>
        <div style={{ color: 'var(--acc)', fontSize: 56, marginBottom: 16 }}>
          <Icon name="checkCircle" />
        </div>
        <h1>{t('Flow complete!')}</h1>
        <p className="dim" style={{ margin: '8px 0 24px', fontSize: 16 }}>
          {t('Completed {0} moves in {1}.', totalMoves, formatTime(totalElapsed))}
        </p>
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
