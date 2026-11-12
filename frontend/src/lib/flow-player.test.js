import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import {
  FLOW_ROUTINE_KINDS,
  isFlowRoutine,
  formatMoveAnnouncement,
  createFlowMoves,
  createFlowPlayer,
} from './flow-player.js'
import FlowPlayer from '../views/FlowPlayer.jsx'

describe('flow-player (Issue #78)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllTimers()
  })

  describe('FLOW_ROUTINE_KINDS and isFlowRoutine', () => {
    it('defines supported flow routine kinds', () => {
      expect(FLOW_ROUTINE_KINDS).toEqual(['hiit', 'yoga', 'mobility'])
    })

    it('identifies flow routines correctly', () => {
      expect(isFlowRoutine('hiit')).toBe(true)
      expect(isFlowRoutine('yoga')).toBe(true)
      expect(isFlowRoutine('mobility')).toBe(true)
      expect(isFlowRoutine({ kind: 'hiit' })).toBe(true)
      expect(isFlowRoutine({ kind: 'yoga' })).toBe(true)
      expect(isFlowRoutine({ kind: 'mobility' })).toBe(true)

      expect(isFlowRoutine('gym')).toBe(false)
      expect(isFlowRoutine({ kind: 'gym' })).toBe(false)
      expect(isFlowRoutine(null)).toBe(false)
      expect(isFlowRoutine({})).toBe(false)
    })
  })

  describe('formatMoveAnnouncement', () => {
    it('formats TTS announcement matching Issue #78 specification verbatim', () => {
      // Issue #78 requirement: "Next move: Downward Dog. 30 seconds."
      const announcement = formatMoveAnnouncement('Downward Dog', 30)
      expect(announcement).toBe('Next move: Downward Dog. 30 seconds.')
    })

    it('formats announcement with different durations and move names', () => {
      expect(formatMoveAnnouncement('Warrior II', 45)).toBe('Next move: Warrior II. 45 seconds.')
      expect(formatMoveAnnouncement('High Knees', 20)).toBe('Next move: High Knees. 20 seconds.')
    })

    it('handles singular 1 second gracefully', () => {
      expect(formatMoveAnnouncement('Plank Hold', 1)).toBe('Next move: Plank Hold. 1 second.')
    })
  })

  describe('createFlowMoves', () => {
    it('returns empty array for invalid or empty routine', () => {
      expect(createFlowMoves(null)).toEqual([])
      expect(createFlowMoves({})).toEqual([])
      expect(createFlowMoves({ ex: [] })).toEqual([])
    })

    it('expands routine exercises into sequential flow moves with durations', () => {
      const routine = {
        id: 'r-yoga',
        name: 'Morning Yoga',
        kind: 'yoga',
        ex: [
          { id: 'pose-1', name: 'Downward Dog', sec: 30 },
          { id: 'pose-2', name: 'Cobra Pose', time: 45 },
          { id: 'pose-3', name: 'Childs Pose' }, // default duration fallback
        ]
      }

      const moves = createFlowMoves(routine)
      expect(moves).toHaveLength(3)

      expect(moves[0].name).toBe('Downward Dog')
      expect(moves[0].duration).toBe(30)
      expect(moves[0].setIndex).toBe(1)
      expect(moves[0].totalSets).toBe(1)

      expect(moves[1].name).toBe('Cobra Pose')
      expect(moves[1].duration).toBe(45)

      expect(moves[2].name).toBe('Childs Pose')
      expect(moves[2].duration).toBe(30) // default 30s
    })

    it('handles multiple sets for interval circuits', () => {
      const routine = {
        id: 'r-hiit',
        name: 'Tabata',
        kind: 'hiit',
        ex: [
          { id: 'm1', name: 'Burpees', sec: 20, sets: 2 },
          { id: 'm2', name: 'Jumping Jacks', sec: 30, sets: 1 }
        ]
      }

      const moves = createFlowMoves(routine)
      expect(moves).toHaveLength(3)
      expect(moves[0].name).toBe('Burpees')
      expect(moves[0].setIndex).toBe(1)
      expect(moves[0].totalSets).toBe(2)

      expect(moves[1].name).toBe('Burpees')
      expect(moves[1].setIndex).toBe(2)
      expect(moves[1].totalSets).toBe(2)

      expect(moves[2].name).toBe('Jumping Jacks')
      expect(moves[2].setIndex).toBe(1)
    })
  })

  describe('createFlowPlayer engine and interval progression', () => {
    const routine = {
      id: 'r-flow',
      name: 'Flow Routine',
      kind: 'yoga',
      ex: [
        { id: 'e1', name: 'Downward Dog', sec: 30 },
        { id: 'e2', name: 'Warrior II', sec: 20 }
      ]
    }

    it('initializes in idle state with first move ready', () => {
      const player = createFlowPlayer(routine)
      const state = player.getState()

      expect(state.status).toBe('idle')
      expect(state.currentIndex).toBe(0)
      expect(state.totalMoves).toBe(2)
      expect(state.currentMove.name).toBe('Downward Dog')
      expect(state.timeRemaining).toBe(30)
      expect(state.elapsed).toBe(0)
      expect(state.totalElapsed).toBe(0)
      expect(state.isPaused).toBe(false)
      expect(state.isCompleted).toBe(false)
    })

    it('speaks initial move announcement on start with ducking', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, { speak: mockSpeak })

      player.start()
      const state = player.getState()

      expect(state.status).toBe('playing')
      expect(mockSpeak).toHaveBeenCalledTimes(1)
      expect(mockSpeak).toHaveBeenCalledWith('Next move: Downward Dog. 30 seconds.', { ducking: true })
    })

    it('auto-advances interval progression on timer ticks and announces next move', () => {
      const mockSpeak = vi.fn()
      const onMoveChange = vi.fn()
      const onComplete = vi.fn()

      const player = createFlowPlayer(routine, {
        speak: mockSpeak,
        onMoveChange,
        onComplete
      })

      player.start()
      expect(mockSpeak).toHaveBeenCalledWith('Next move: Downward Dog. 30 seconds.', { ducking: true })

      // Advance 10 seconds into Downward Dog
      player.tick(10)
      let s = player.getState()
      expect(s.timeRemaining).toBe(20)
      expect(s.elapsed).toBe(10)
      expect(s.totalElapsed).toBe(10)
      expect(s.currentIndex).toBe(0)

      // Advance 20 more seconds to finish move 1 (total 30s)
      player.tick(20)
      s = player.getState()

      // Auto-advanced to move 2: Warrior II (20s)
      expect(s.currentIndex).toBe(1)
      expect(s.currentMove.name).toBe('Warrior II')
      expect(s.timeRemaining).toBe(20)
      expect(s.elapsed).toBe(0)
      expect(s.totalElapsed).toBe(30)

      // Verifies TTS announced transition to Warrior II
      expect(mockSpeak).toHaveBeenCalledTimes(2)
      expect(mockSpeak).toHaveBeenLastCalledWith('Next move: Warrior II. 20 seconds.', { ducking: true })
      expect(onMoveChange).toHaveBeenCalledTimes(1)

      // Advance 20 seconds to finish Warrior II (total 50s)
      player.tick(20)
      s = player.getState()

      // Workout complete
      expect(s.status).toBe('completed')
      expect(s.isCompleted).toBe(true)
      expect(s.timeRemaining).toBe(0)
      expect(s.totalElapsed).toBe(50)
      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    it('advances in real-time with setInterval timer', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, { speak: mockSpeak })

      player.start()
      expect(player.getState().timeRemaining).toBe(30)

      // Fast forward 5 seconds
      vi.advanceTimersByTime(5000)
      expect(player.getState().timeRemaining).toBe(25)
      expect(player.getState().totalElapsed).toBe(5)

      player.destroy()
    })
  })

  describe('player controls: pause, resume, skip, restartMove', () => {
    const routine = {
      id: 'r-mobility',
      name: 'Mobility Routine',
      kind: 'mobility',
      ex: [
        { id: 'm1', name: 'Cat Cow', sec: 30 },
        { id: 'm2', name: 'World Greatest Stretch', sec: 40 }
      ]
    }

    it('handles pause and resume controls and stops speaking on pause', () => {
      const mockSpeak = vi.fn()
      const mockStopSpeaking = vi.fn()

      const player = createFlowPlayer(routine, {
        speak: mockSpeak,
        stopSpeaking: mockStopSpeaking
      })

      player.start()
      player.tick(5)
      expect(player.getState().timeRemaining).toBe(25)
      expect(player.getState().isPlaying).toBe(true)

      // Pause
      player.pause()
      expect(player.getState().status).toBe('paused')
      expect(player.getState().isPaused).toBe(true)
      expect(mockStopSpeaking).toHaveBeenCalledTimes(1)

      // Timer ticks do nothing while paused
      player.tick(5)
      expect(player.getState().timeRemaining).toBe(25)

      // Resume
      player.resume()
      expect(player.getState().status).toBe('playing')
      expect(player.getState().isPaused).toBe(false)

      player.tick(5)
      expect(player.getState().timeRemaining).toBe(20)

      // Toggle pause
      player.togglePause()
      expect(player.getState().isPaused).toBe(true)
      player.togglePause()
      expect(player.getState().isPlaying).toBe(true)

      player.destroy()
    })

    it('skip advances immediately to next move and announces it', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, { speak: mockSpeak })

      player.start()
      expect(mockSpeak).toHaveBeenCalledWith('Next move: Cat Cow. 30 seconds.', { ducking: true })

      // User taps skip button
      player.skip()
      const s = player.getState()

      expect(s.currentIndex).toBe(1)
      expect(s.currentMove.name).toBe('World Greatest Stretch')
      expect(s.timeRemaining).toBe(40)
      expect(s.elapsed).toBe(0)

      expect(mockSpeak).toHaveBeenCalledTimes(2)
      expect(mockSpeak).toHaveBeenLastCalledWith('Next move: World Greatest Stretch. 40 seconds.', { ducking: true })

      // Skip on last move completes workout
      player.skip()
      expect(player.getState().status).toBe('completed')
      expect(player.getState().isCompleted).toBe(true)
    })

    it('restartMove resets the countdown of the current move to its beginning', () => {
      const player = createFlowPlayer(routine)
      player.start()

      // Advance 15 seconds
      player.tick(15)
      expect(player.getState().timeRemaining).toBe(15)
      expect(player.getState().elapsed).toBe(15)

      // Restart move
      player.restartMove()
      const s = player.getState()

      expect(s.timeRemaining).toBe(30)
      expect(s.elapsed).toBe(0)
      expect(s.currentIndex).toBe(0)
    })

    it('previous navigates back to the preceding move and announces it', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, { speak: mockSpeak })

      player.start()
      player.skip()
      expect(player.getState().currentIndex).toBe(1)

      player.previous()
      expect(player.getState().currentIndex).toBe(0)
      expect(player.getState().currentMove.name).toBe('Cat Cow')
      expect(mockSpeak).toHaveBeenLastCalledWith('Next move: Cat Cow. 30 seconds.', { ducking: true })
    })

    it('suppresses speech announcements when voiceCues is false', () => {
      const mockSpeak = vi.fn()
      const player = createFlowPlayer(routine, {
        speak: mockSpeak,
        voiceCues: false
      })

      player.start()
      expect(mockSpeak).not.toHaveBeenCalled()

      player.skip()
      expect(mockSpeak).not.toHaveBeenCalled()
    })
  })

  describe('FlowPlayer React view rendering', () => {
    it('renders empty placeholder if routine has no exercises', () => {
      const html = renderToStaticMarkup(
        React.createElement(MemoryRouter, null,
          React.createElement(FlowPlayer, { routine: { id: 'r-empty', name: 'Empty Routine', ex: [] } })
        )
      )
      expect(html).toContain('No exercises in this routine')
    })

    it('renders active move, kind badge, countdown timer, and control buttons', () => {
      const routine = {
        id: 'r-yoga',
        name: 'Morning Yoga',
        kind: 'yoga',
        ex: [
          { id: 'pose-1', name: 'Downward Dog', sec: 30 },
          { id: 'pose-2', name: 'Warrior II', sec: 45 }
        ]
      }

      const html = renderToStaticMarkup(
        React.createElement(MemoryRouter, null,
          React.createElement(FlowPlayer, { routine })
        )
      )

      expect(html).toContain('Morning Yoga')
      expect(html).toContain('Yoga')
      expect(html).toContain('Downward Dog')
      expect(html).toContain('0:30')
      expect(html).toContain('Up next: Warrior II (45s)')
      expect(html).toContain('Restart move')
      expect(html).toContain('Skip move')
    })
  })
})
