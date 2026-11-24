import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Home from './Home.jsx'
import { useStore, DEF } from '../store/useStore.js'
import { todayISO } from '../lib/format.js'

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

describe('Multi-Sport Home View (Issue #98)', () => {
  beforeEach(() => {
    useStore.getInitialState = () => useStore.getState()
    useStore.setState({ S: JSON.parse(JSON.stringify(DEF)), user: null, config: {} })
  })

  it('removes temporary Record Cardio button and renders 4-template onboarding chooser when empty', () => {
    const html = renderToStaticMarkup(React.createElement(Home))
    expect(html).not.toContain('Record Cardio')
    expect(html).toContain('data-testid="home-onboarding-chooser"')
    expect(html).toContain('data-testid="home-today-card"')
    expect(html.indexOf('data-testid="home-onboarding-chooser"')).toBeLessThan(html.indexOf('data-testid="home-today-card"'))
    expect(html.indexOf('Welcome!')).toBeGreaterThan(-1)
    expect(html.indexOf('Welcome!')).toBeLessThan(html.indexOf('Rest &amp; Recovery'))
    expect(html).toMatch(/<button[^>]*class="btn plain sm[^"]*"[^>]*><span>Adjust<\/span><\/button>/)
    expect(html).not.toContain('height:24px')
    expect(html).toContain('data-testid="starter-option-hybrid"')
    expect(html).toContain('data-testid="starter-option-endurance"')
    expect(html).toContain('data-testid="starter-option-ppl"')
    expect(html).toContain('data-testid="starter-option-mobility"')
    expect(html).toContain('data-testid="home-rest-state"')
    expect(html).toContain('Rest &amp; Recovery')
    expect(html).toContain('data-testid="home-week-glance"')
    expect(html).toContain('data-testid="bw-quick-pill"')
    expect(html).not.toContain('<svg class="lc"')
  })

  it('renders multi-session Today card and Unified Recent Activity across all 4 pillars', () => {
    const today = todayISO()
    const wd = new Date(today + 'T12:00:00').getDay()
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        bodyweight: [{ d: today, t: Date.now(), w: 72.5 }],
        routines: [
          { id: 'r-push', name: 'Upper Push', kind: 'gym', emoji: 'barbell', ex: [] },
          { id: 'r-yoga', name: 'Evening Yoga', kind: 'yoga', emoji: 'stretch', ex: [] }
        ],
        cardioPlans: [
          { id: 'cp-run', type: 'run', day: wd, targetDistanceM: 5000 }
        ],
        week: { [wd]: ['r-push', 'r-yoga', 'cp-run'] },
        workouts: [
          { id: 'w-1', name: 'Bench Session', d: today, start: Date.now() - 1800000, end: Date.now(), vol: 2000, entries: [] }
        ],
        cardioActivities: [
          { id: 'c-1', type: 'run', cardioType: 'run', name: 'Easy 5K', d: today, durationMs: 1500000, distanceM: 5000 }
        ],
        freestyleSessions: [
          { id: 'f-1', name: 'Morning Flow', kind: 'yoga', d: today, durationMs: 900000 }
        ]
      }
    })

    const html = renderToStaticMarkup(React.createElement(Home))
    expect(html).not.toContain('Record Cardio')
    expect(html).toContain('data-testid="home-today-card"')
    expect(html).not.toContain('data-testid="home-onboarding-chooser"')
    expect(html).toContain('Upper Push')
    expect(html).toContain('Evening Yoga')
    expect(html).toContain('5 km')
    expect(html).toContain('72.5 kg')
    expect(html).toContain('data-testid="unified-recent-activity"')
    expect(html).toContain('Bench Session')
    expect(html).toContain('Easy 5K')
    expect(html).toContain('Morning Flow')
    expect(html).toContain('pillar-strength')
    expect(html).toContain('pillar-cardio')
    expect(html).toContain('pillar-flow')
  })

  it('renders Today card with rest state and without onboarding chooser on non-empty rest day', () => {
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        routines: [{ id: 'r-push', name: 'Upper Push', kind: 'gym', emoji: 'barbell', ex: [] }],
        week: {}
      }
    })

    const html = renderToStaticMarkup(React.createElement(Home))
    expect(html).toContain('data-testid="home-today-card"')
    expect(html).toContain('data-testid="home-rest-state"')
    expect(html).toContain('Rest &amp; Recovery')
    expect(html).not.toContain('data-testid="home-onboarding-chooser"')
    expect(html).toMatch(/<button[^>]*class="btn plain sm[^"]*"[^>]*><span>Adjust<\/span><\/button>/)
  })

  it('formats cardio avgPaceSecKm cleanly in metric and imperial without 300:00 bug', () => {
    const today = todayISO()
    const baseRun = { id: 'c-pace', type: 'run', cardioType: 'run', name: 'Tempo Run', d: today, durationMs: 1500000, distanceM: 5000, avgPaceSecKm: 300 }

    useStore.setState({ S: { ...JSON.parse(JSON.stringify(DEF)), unit: 'kg', cardioActivities: [baseRun] } })
    const kgHtml = renderToStaticMarkup(React.createElement(Home))
    expect(kgHtml).toContain('5:00 min/km')
    expect(kgHtml).not.toContain('300:00')

    useStore.setState({ S: { ...JSON.parse(JSON.stringify(DEF)), unit: 'lb', cardioActivities: [baseRun] } })
    const lbHtml = renderToStaticMarkup(React.createElement(Home))
    expect(lbHtml).toContain('8:03 min/mi')
    expect(lbHtml).not.toContain('300:00')
  })
})
