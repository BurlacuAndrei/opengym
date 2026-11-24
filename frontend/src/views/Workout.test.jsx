import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Workout from './Workout.jsx'
import { useStore, DEF } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn()
}))

vi.mock('../store/useStore.js', async importOriginal => {
  const actual = await importOriginal()
  const useStoreMock = selector => {
    const s = actual.useStore.getState()
    return selector ? selector(s) : s
  }
  Object.assign(useStoreMock, actual.useStore)
  return { ...actual, useStore: useStoreMock }
})

vi.mock('../store/useUI.js', async importOriginal => {
  const actual = await importOriginal()
  const useUIMock = selector => {
    const s = actual.useUI.getState()
    return selector ? selector(s) : s
  }
  Object.assign(useUIMock, actual.useUI)
  return { ...actual, useUI: useUIMock }
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

describe('Workout view (Issue #10e)', () => {
  beforeEach(() => {
    useStore.getInitialState = () => useStore.getState()
    useUI.getInitialState = () => useUI.getState()
    useStore.setState({ S: JSON.parse(JSON.stringify(DEF)), user: null, config: {} })
  })

  it('renders StartChooser when S.active is null without crashing in SSR node env', () => {
    const html = renderToStaticMarkup(React.createElement(Workout))
    expect(html).toContain('Start workout')
    expect(html).not.toContain('workout-active')
  })

  it('renders .workout-active around active workout with Finish workout early and no inline 40px spacer', () => {
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        active: {
          name: 'Push Day',
          start: Date.now(),
          cur: 0,
          entries: [
            {
              id: 'bench',
              target: { sets: 1, reps: 8 },
              sets: [{ w: 60, r: 8, done: false }]
            }
          ]
        }
      }
    })

    const html = renderToStaticMarkup(React.createElement(Workout))
    expect(html).toContain('class="narrow workout-active"')
    expect(html).toContain('Finish workout early · 0/1 exercises')
    expect(html).not.toContain('height:40px')
  })

  it('renders Finish workout primary button when all sets are done', () => {
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        active: {
          name: 'Push Day',
          start: Date.now(),
          cur: 0,
          entries: [
            {
              id: 'bench',
              target: { sets: 1, reps: 8 },
              sets: [{ w: 60, r: 8, done: true }]
            }
          ]
        }
      }
    })

    const html = renderToStaticMarkup(React.createElement(Workout))
    expect(html).toContain('class="narrow workout-active"')
    expect(html).toContain('class="btn primary"')
    expect(html).toContain('Finish workout')
    expect(html).not.toContain('Finish workout early')
  })
})
