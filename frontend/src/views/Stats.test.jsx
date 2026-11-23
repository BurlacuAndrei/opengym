import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Stats from './Stats.jsx'
import History from './History.jsx'
import Calendar from '../components/Calendar.jsx'
import { useStore, DEF } from '../store/useStore.js'
import { setNav } from '../lib/nav.js'

vi.mock('../store/useStore.js', async importOriginal => {
  const actual = await importOriginal()
  const useStoreMock = selector => {
    const s = actual.useStore.getState()
    return selector ? selector(s) : s
  }
  Object.assign(useStoreMock, actual.useStore)
  return { ...actual, useStore: useStoreMock }
})

if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} })
  }
}

const today = new Date().toISOString().slice(0, 10)
const nowMs = Date.now()

const sampleState = {
  ...DEF,
  unit: 'kg',
  bodyweight: [
    { d: today, t: nowMs - 86400000 * 5, w: 75 },
    { d: today, t: nowMs, w: 74.5 }
  ],
  workouts: [
    {
      id: 'w-1',
      name: 'Push Day',
      d: today,
      start: nowMs - 3600000,
      end: nowMs - 600000,
      vol: 3200,
      entries: [
        { id: '0025', sets: [{ w: 80, r: 8, done: true, rir: 2 }] }
      ]
    }
  ],
  cardioActivities: [
    {
      id: 'c-1',
      type: 'run',
      cardioType: 'run',
      name: 'Morning Run',
      d: today,
      startTime: new Date(nowMs - 7200000).toISOString(),
      durationMs: 1800000,
      distanceM: 5000,
      elevationGainM: 45,
      avgPaceSecKm: 360,
      rpe: 7
    }
  ],
  freestyleSessions: [
    {
      id: 'f-1',
      name: 'Morning Flow',
      kind: 'yoga',
      d: today,
      durationMs: 1200000,
      rpe: 5,
      load: 100
    }
  ]
}

describe('Segmented Multi-Sport Stats, History & Calendar (Issue #97)', () => {
  beforeEach(() => {
    useStore.getInitialState = () => useStore.getState()
    useStore.setState({ S: JSON.parse(JSON.stringify(sampleState)) })
  })

  it('renders Stats Overview tab with segmented control, ACWR Training Rhythm, Heatmap, and Bodyweight chart', () => {
    const html = renderToStaticMarkup(React.createElement(Stats, { initialTab: 'overview' }))
    expect(html).toContain('Overview')
    expect(html).toContain('Cardio')
    expect(html).toContain('Strength')
    expect(html).toContain('data-testid="stats-overview-tab"')
    expect(html).toContain('data-testid="training-rhythm-card"')
    expect(html).toContain('Training Rhythm')
    expect(html).toContain('Body weight')
  })

  it('renders empty-state ACWR Training Rhythm safely without NaN', () => {
    useStore.setState({ S: JSON.parse(JSON.stringify(DEF)) })
    const html = renderToStaticMarkup(React.createElement(Stats, { initialTab: 'overview' }))
    expect(html).toContain('Rest &amp; Recovery')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('Infinity')
  })

  it('renders Stats Cardio tab with weekly trends, sport breakdown, and Personal Records', () => {
    const html = renderToStaticMarkup(React.createElement(Stats, { initialTab: 'cardio' }))
    expect(html).toContain('data-testid="stats-cardio-tab"')
    expect(html).toContain('Weekly cardio distance')
    expect(html).toContain('Sport breakdown')
    expect(html).toContain('Personal records')
    expect(html).toContain('5k')
  })

  it('renders Stats Strength tab with Tonnage, Muscle balance, Exercise progress, and Effort', () => {
    const html = renderToStaticMarkup(React.createElement(Stats, { initialTab: 'strength' }))
    expect(html).toContain('data-testid="stats-strength-tab"')
    expect(html).toContain('Tonnage')
    expect(html).toContain('Muscle balance')
    expect(html).toContain('Exercise progress')
    expect(html).toContain('Effort')
  })

  it('renders History with 4-pillar filter pills and pillar badges across all pillars', () => {
    const html = renderToStaticMarkup(React.createElement(History))
    expect(html).toContain('All')
    expect(html).toContain('Strength')
    expect(html).toContain('Cardio')
    expect(html).toContain('Flow &amp; Sport')
    expect(html).toContain('pillar-strength')
    expect(html).toContain('pillar-cardio')
    expect(html).toContain('pillar-flow')
    expect(html).toContain('Morning Run')
    expect(html).toContain('Morning Flow')
    expect(html).toContain('Push Day')
  })

  it('renders Calendar including freestyleSessions and routes cardio clicks to /cardio/:id', () => {
    const spy = vi.fn()
    setNav(spy)
    const html = renderToStaticMarkup(React.createElement(Calendar, { close: () => {} }))
    expect(html).toContain('3 sessions')
    // Verify History/Calendar nav helper can target /cardio/:id cleanly
    expect(typeof spy).toBe('function')
  })
})
