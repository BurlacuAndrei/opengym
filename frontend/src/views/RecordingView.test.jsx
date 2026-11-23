import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import RecordingView, {
  RECORDING_SPORTS,
  resolveDefaultGearForSport,
  finalizeRecordingLinks
} from './RecordingView.jsx'
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

describe('Pre-Start Cardio Recording Setup (Issue #99)', () => {
  beforeEach(() => {
    useStore.getInitialState = () => useStore.getState()
    useStore.setState({ S: JSON.parse(JSON.stringify(DEF)), user: null })
  })

  it('renders 6 sports, planned target selector, route selector, gear selector, and Web fallback shortcuts when idle', () => {
    const today = todayISO()
    const wd = new Date(today + 'T12:00:00').getDay()
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        cardioPlans: [
          { id: 'cp-1', type: 'run', day: wd, targetDistanceM: 8000, intervals: [{ type: 'work', durationSec: 120 }] }
        ],
        routes: [
          { id: 'rt-1', name: 'River Loop', distanceM: 5200 }
        ],
        gear: [
          { id: 'g-shoe', name: 'Pegasus 41', type: 'shoe', isDefault: true, retired: false },
          { id: 'g-bike', name: 'Canyon Road', type: 'bike', isDefault: true, retired: false }
        ]
      }
    })

    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: '/record', search: '?route=rt-1', state: { followRouteId: 'rt-1', activityType: 'run' } }] },
        React.createElement(Routes, null, React.createElement(Route, { path: '/record', element: React.createElement(RecordingView) }))
      )
    )

    for (const sp of RECORDING_SPORTS) {
      expect(html).toContain(`data-testid="sport-btn-${sp}"`)
    }
    expect(html).toContain('data-testid="plan-selector"')
    expect(html).toContain('8 km')
    expect(html).toContain('data-testid="route-selector"')
    expect(html).toContain('River Loop')
    expect(html).toContain('data-testid="gear-selector"')
    expect(html).toContain('Pegasus 41')
    expect(html).toContain('data-testid="web-fallback-banner"')
    expect(html).toContain('Log Manual Cardio')
    expect(html).toContain('Import GPX')
  })

  it('resolveDefaultGearForSport picks default non-retired gear matching sport category', () => {
    const gear = [
      { id: 's1', name: 'Old Shoe', type: 'shoe', isDefault: true, retired: true },
      { id: 's2', name: 'Daily Trainer', type: 'shoe', isDefault: true, retired: false },
      { id: 'b1', name: 'Gravel Bike', type: 'bike', isDefault: true, retired: false }
    ]
    expect(resolveDefaultGearForSport(gear, 'run')).toBe('s2')
    expect(resolveDefaultGearForSport(gear, 'ride')).toBe('b1')
    expect(resolveDefaultGearForSport([], 'run')).toBe('')
  })

  it('finalizeRecordingLinks attributes distance to gear and marks linked cardioPlan completed', () => {
    const accFn = vi.fn()
    const updateActFn = vi.fn()
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        cardioPlans: [{ id: 'cp-run', type: 'run', targetDistanceM: 5000, completed: false }]
      }
    })

    finalizeRecordingLinks(
      { id: 'act-99', distanceM: 5120 },
      {
        selectedGearId: 'g-shoe',
        selectedPlanId: 'cp-run',
        accumulateGearFn: accFn,
        updateCardioActivityFn: updateActFn,
        updateStoreFn: useStore.getState().update
      }
    )

    expect(accFn).toHaveBeenCalledWith('g-shoe', 5120)
    expect(updateActFn).toHaveBeenCalledWith('act-99', { gearId: 'g-shoe' })
    const updatedPlan = useStore.getState().S.cardioPlans.find(p => p.id === 'cp-run')
    expect(updatedPlan.completed).toBe(true)
    expect(updatedPlan.completedActivityId).toBe('act-99')
  })
})
