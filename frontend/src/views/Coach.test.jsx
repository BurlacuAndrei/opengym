import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Coach from './Coach.jsx'
import CoachProposal from './CoachProposal.jsx'
import { useStore, DEF } from '../store/useStore.js'
import * as coachLib from '../lib/coach.js'
import * as coachApi from '../lib/coach-api.js'

// Mock react-router-dom useNavigate
const mockNavigate = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()]
}))

vi.mock('../store/useStore.js', async (importOriginal) => {
  const actual = await importOriginal()
  const useStoreMock = (selector) => {
    const s = actual.useStore.getState()
    return selector ? selector(s) : s
  }
  Object.assign(useStoreMock, actual.useStore)
  return {
    ...actual,
    useStore: useStoreMock
  }
})

describe('Coach view - per-modality switches and proposal diff display (Issue #81)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(coachLib, 'coachAvailable').mockReturnValue(true)
    useStore.setState({
      config: { coach: { enabled: true } },
      user: { id: 'u1', name: 'Tester' },
      S: {
        ...DEF,
        coach: {
          consent: { agreedAt: '2026-07-01T00:00:00Z', version: 2 },
          profile: {
            goal: 'general',
            daysPerWeek: 3,
            sessionMin: 45,
            modalities: { gym: true, cardio: true, hiit: true, yoga: false, mobility: false },
            sessionsPerWeek: { gym: 3, cardio: 2, hiit: 1, yoga: 1, mobility: 1 }
          },
          cadence: 'off',
          log: []
        },
        routines: [{ id: 'r1', name: 'Gym Day', ex: [{ id: '0001', sets: 3, reps: 10 }] }]
      }
    })
    useStore.getInitialState = () => useStore.getState()
  })

  it('renders per-modality AI coach switches and target sessions', () => {
    vi.spyOn(coachApi, 'useCoachStatus').mockReturnValue({
      job: null,
      pending: null,
      cap: null,
      refresh: vi.fn()
    })

    const html = renderToStaticMarkup(<Coach />)

    // Verify all modalities are rendered with their labels
    expect(html).toContain('Gym')
    expect(html).toContain('Cardio')
    expect(html).toContain('Hiit')
    expect(html).toContain('Yoga')
    expect(html).toContain('Mobility')

    // Enabled modalities display target sessions per week
    expect(html).toContain('3 sessions / week')
    expect(html).toContain('2 sessions / week')
    expect(html).toContain('1 sessions / week')
    // Disabled modalities display Disabled
    expect(html).toContain('Disabled')
  })

  it('renders Coach Proposal diff view with routine kind badges, restSec, and customEx descriptions', () => {
    const pendingProposal = {
      id: 'prop-1',
      kind: 'create',
      bundle: {
        name: 'Hybrid Athletic Plan',
        routines: [
          {
            id: 'r_hiit',
            name: 'Sprint Power',
            emoji: '⚡',
            kind: 'hiit',
            restSec: 30,
            ex: [{ id: '0001', sets: 4, reps: 15 }]
          },
          {
            id: 'r_yoga',
            name: 'Flow & Breathe',
            emoji: '🧘',
            kind: 'yoga',
            restSec: 15,
            ex: [{ id: '0007', sets: 3, sec: 60, mode: 'time' }]
          },
          {
            id: 'r_mob',
            name: 'Joint Reset',
            emoji: '🤸',
            kind: 'mobility',
            restSec: 0,
            ex: [{ id: 'cx_mob', sets: 2, sec: 45, mode: 'time' }]
          }
        ],
        customEx: [
          {
            id: 'cx_mob',
            n: '90-90 Hip Switch',
            bp: 'hips',
            desc: 'Smooth controlled rotation switching between internal and external hip rotation.'
          }
        ]
      }
    }

    vi.spyOn(coachApi, 'useCoachStatus').mockReturnValue({
      job: null,
      pending: pendingProposal,
      cap: null,
      refresh: vi.fn()
    })

    const html = renderToStaticMarkup(<Coach />)

    // Proposal card rendered
    expect(html).toContain('data-testid="coach-proposal-card"')

    // Routine names rendered
    expect(html).toContain('Sprint Power')
    expect(html).toContain('Flow &amp; Breathe')
    expect(html).toContain('Joint Reset')

    // Routine kind badges rendered
    expect(html.toLowerCase()).toContain('hiit')
    expect(html.toLowerCase()).toContain('yoga')
    expect(html.toLowerCase()).toContain('mobility')

    // Per-routine restSec rendered
    expect(html).toContain('30s rest')
    expect(html).toContain('15s rest')
    expect(html).toContain('0s rest')

    // CustomEx description rendered clearly
    expect(html).toContain('90-90 Hip Switch')
    expect(html).toContain('Smooth controlled rotation switching between internal and external hip rotation.')
  })

  it('renders CoachProposal full view with routine kind badges and customEx descriptions', () => {
    const pendingProposal = {
      id: 'prop-2',
      kind: 'create',
      bundle: {
        name: 'Movement & Conditioning',
        routines: [
          {
            id: 'r_hiit',
            name: 'MetCon Circuit',
            emoji: '🔥',
            kind: 'hiit',
            restSec: 25,
            ex: [{ id: '0001', sets: 3, reps: 12 }]
          }
        ],
        customEx: [
          {
            id: 'cx_band',
            n: 'Band Pull-Apart Flow',
            bp: 'upper back',
            desc: 'Continuous tension band pull-apart with overhead reach.'
          }
        ]
      }
    }

    vi.spyOn(coachApi, 'useCoachStatus').mockReturnValue({
      job: null,
      pending: pendingProposal,
      loading: false,
      refresh: vi.fn()
    })

    const html = renderToStaticMarkup(<CoachProposal />)

    expect(html).toContain('MetCon Circuit')
    expect(html.toLowerCase()).toContain('hiit')
    expect(html).toContain('25s rest')
    expect(html).toContain('Band Pull-Apart Flow')
    expect(html).toContain('Continuous tension band pull-apart with overhead reach.')
  })
})
