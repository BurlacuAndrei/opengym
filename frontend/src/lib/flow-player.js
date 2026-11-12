import { getRoutineKind } from './routine-kind.js'
import { exOr } from './exercises.js'
import { speak as defaultSpeak, stopSpeaking as defaultStopSpeaking } from './cardio-adapter.js'
import { t } from './i18n.js'

/**
 * Supported routine kinds for Flow / Circuit player (Issue #78).
 */
export const FLOW_ROUTINE_KINDS = ['hiit', 'yoga', 'mobility']

/**
 * Checks if a routine or kind is eligible for the Flow player.
 * Only 'hiit', 'yoga', and 'mobility' routines auto-advance in flow mode.
 *
 * @param {Object|string} routineOrKind - Routine object or kind string
 * @returns {boolean}
 */
export function isFlowRoutine(routineOrKind) {
  const kind = getRoutineKind(routineOrKind)
  return FLOW_ROUTINE_KINDS.includes(kind)
}

/**
 * Formats the text-to-speech announcement for an upcoming move.
 * Format specified in Issue #78: "Next move: Downward Dog. 30 seconds."
 *
 * @param {string} moveName - Name of the move / exercise
 * @param {number} durationSec - Hold/work duration in seconds
 * @returns {string}
 */
export function formatMoveAnnouncement(moveName, durationSec) {
  const name = moveName || t('Next exercise')
  const sec = Math.max(1, Math.round(Number(durationSec) || 30))
  const secLabel = sec === 1 ? t('1 second') : t('{0} seconds', sec)
  return `Next move: ${name}. ${secLabel}.`
}

/**
 * Expands a routine's exercises into an ordered list of flow moves.
 *
 * @param {Object} routine - Routine with .ex array
 * @param {Object} [options={}] - Options (e.g. defaultMoveDuration)
 * @returns {Array<Object>} List of move definitions
 */
export function createFlowMoves(routine, options = {}) {
  const defaultDuration = Number(options.defaultMoveDuration) || 30
  if (!routine || !Array.isArray(routine.ex) || routine.ex.length === 0) {
    return []
  }

  const moves = []
  routine.ex.forEach((entry, exIdx) => {
    const exMeta = exOr(entry.id)
    const name = entry.name || exMeta.n || t('Move {0}', exIdx + 1)
    const rawDuration = entry.sec ?? entry.time ?? entry.duration
    const duration = rawDuration != null && Number(rawDuration) > 0
      ? Number(rawDuration)
      : defaultDuration

    const sets = Number(entry.sets) > 0 ? Number(entry.sets) : 1
    for (let setIdx = 1; setIdx <= sets; setIdx++) {
      moves.push({
        id: `${entry.id || 'move'}-${exIdx}-${setIdx}`,
        exerciseId: entry.id,
        name,
        duration,
        setIndex: setIdx,
        totalSets: sets,
        exercise: exMeta,
        raw: entry,
      })
    }
  })

  return moves
}

/**
 * Player engine for sequential auto-advancing flow/circuit workouts.
 *
 * @param {Object} routine - Routine to play
 * @param {Object} [options={}] - Engine configuration
 * @returns {Object} Player instance
 */
export function createFlowPlayer(routine, options = {}) {
  const speakFn = options.speak || defaultSpeak
  const stopSpeakingFn = options.stopSpeaking || defaultStopSpeaking
  const voiceCues = options.voiceCues !== false
  const tickIntervalMs = options.tickIntervalMs || 1000

  const moves = createFlowMoves(routine, options)
  const listeners = new Set()

  let currentIndex = 0
  let status = 'idle' // 'idle' | 'playing' | 'paused' | 'completed'
  let timeRemaining = moves.length > 0 ? moves[0].duration : 0
  let elapsed = 0
  let totalElapsed = 0
  let timerId = null

  function notify() {
    const state = getState()
    listeners.forEach(fn => {
      try {
        fn(state)
      } catch (err) {
        // preserve engine integrity if a listener throws
      }
    })
  }

  function announceCurrentMove() {
    if (!voiceCues || currentIndex >= moves.length) return
    const cur = moves[currentIndex]
    const text = formatMoveAnnouncement(cur.name, cur.duration)
    try {
      speakFn(text, { ducking: true })
    } catch {
      // ignore TTS error in engine
    }
  }

  function tick(deltaSec = 1) {
    if (status !== 'playing' || moves.length === 0) return

    totalElapsed += deltaSec
    elapsed += deltaSec
    timeRemaining -= deltaSec

    if (timeRemaining <= 0) {
      // Transition to next move or complete
      if (currentIndex < moves.length - 1) {
        currentIndex++
        const nextMove = moves[currentIndex]
        timeRemaining = nextMove.duration
        elapsed = 0
        announceCurrentMove()
        if (options.onMoveChange) options.onMoveChange(nextMove, getState())
      } else {
        // Completed all moves
        status = 'completed'
        timeRemaining = 0
        stopTimer()
        if (options.onComplete) options.onComplete(getState())
      }
    }

    if (options.onTick) options.onTick(getState())
    notify()
  }

  function startTimer() {
    stopTimer()
    timerId = setInterval(() => {
      tick(1)
    }, tickIntervalMs)
  }

  function stopTimer() {
    if (timerId != null) {
      clearInterval(timerId)
      timerId = null
    }
  }

  function start() {
    if (moves.length === 0) {
      status = 'completed'
      notify()
      return
    }

    status = 'playing'
    announceCurrentMove()
    startTimer()
    notify()
  }

  function pause() {
    if (status === 'playing') {
      status = 'paused'
      stopTimer()
      try {
        stopSpeakingFn()
      } catch {}
      notify()
    }
  }

  function resume() {
    if (status === 'paused') {
      status = 'playing'
      startTimer()
      notify()
    }
  }

  function togglePause() {
    if (status === 'playing') {
      pause()
    } else if (status === 'paused') {
      resume()
    } else if (status === 'idle') {
      start()
    }
  }

  function skip() {
    if (status === 'completed' || moves.length === 0) return

    if (currentIndex < moves.length - 1) {
      currentIndex++
      const nextMove = moves[currentIndex]
      timeRemaining = nextMove.duration
      elapsed = 0
      announceCurrentMove()
      if (options.onMoveChange) options.onMoveChange(nextMove, getState())
      notify()
    } else {
      status = 'completed'
      timeRemaining = 0
      stopTimer()
      if (options.onComplete) options.onComplete(getState())
      notify()
    }
  }

  function restartMove() {
    if (moves.length === 0) return
    const cur = moves[currentIndex]
    timeRemaining = cur ? cur.duration : 0
    elapsed = 0
    notify()
  }

  function previous() {
    if (currentIndex > 0) {
      currentIndex--
      const prevMove = moves[currentIndex]
      timeRemaining = prevMove.duration
      elapsed = 0
      announceCurrentMove()
      if (options.onMoveChange) options.onMoveChange(prevMove, getState())
      notify()
    } else {
      restartMove()
    }
  }

  function stop() {
    stopTimer()
    try {
      stopSpeakingFn()
    } catch {}
    status = 'idle'
    notify()
  }

  function destroy() {
    stop()
    listeners.clear()
  }

  function getState() {
    const cur = moves[currentIndex] || null
    const next = moves[currentIndex + 1] || null
    return {
      status,
      isPaused: status === 'paused',
      isPlaying: status === 'playing',
      isCompleted: status === 'completed',
      isIdle: status === 'idle',
      currentIndex,
      totalMoves: moves.length,
      currentMove: cur,
      nextMove: next,
      timeRemaining,
      elapsed,
      totalElapsed,
      moves,
      routine,
    }
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  if (options.autoStart) {
    start()
  }

  return {
    start,
    pause,
    resume,
    togglePause,
    skip,
    restartMove,
    previous,
    tick,
    stop,
    destroy,
    getState,
    subscribe,
    get moves() { return moves },
  }
}
