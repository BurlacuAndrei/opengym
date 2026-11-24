import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import History from './History.jsx'
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

// matchMedia mock pattern from useStore.test.js: ?cardio= only opens the side
// pane when the viewport is ≥1024px, i.e. matchMedia reports matches:true.
const origWindow = globalThis.window
function setMatchMedia(matches) {
  if (matches == null) {
    if (origWindow === undefined) delete globalThis.window
    else globalThis.window = origWindow
  } else {
    const mql = {
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    globalThis.window = { matchMedia: vi.fn(() => mql) }
  }
}

describe('History master-detail at ≥1024px (issue #116)', () => {
  beforeEach(() => {
    useStore.getInitialState = () => useStore.getState()
    useStore.setState({
      S: {
        ...JSON.parse(JSON.stringify(DEF)),
        cardioActivities: [
          { id: 'c-1', type: 'run', cardioType: 'run', name: 'Easy 5K', d: todayISO(), durationMs: 1500000, distanceM: 5000 }
        ]
      },
      user: null,
      config: {}
    })
  })

  afterEach(() => setMatchMedia(null))

  const render = entry => renderToStaticMarkup(
    React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(History))
  )

  it('wide + ?cardio= renders the list and the ActivityDetail side pane together', () => {
    setMatchMedia(true)
    const html = render('/history?cardio=c-1')
    expect(html).toContain('class="list"')
    expect(html).toContain('Easy 5K')
    expect(html).toContain('class="split"')
    expect(html).toContain('data-testid="activity-detail-view"')
  })

  it('wide without a selection renders the plain list, no pane', () => {
    setMatchMedia(true)
    const html = render('/history')
    expect(html).toContain('class="list"')
    expect(html).toContain('Easy 5K')
    expect(html).not.toContain('class="split"')
    expect(html).not.toContain('data-testid="activity-detail-view"')
  })

  it('below 1024px the ?cardio= query is ignored — mobile markup unchanged', () => {
    setMatchMedia(false)
    const html = render('/history?cardio=c-1')
    expect(html).toContain('class="list"')
    expect(html).toContain('Easy 5K')
    expect(html).not.toContain('class="split"')
    expect(html).not.toContain('data-testid="activity-detail-view"')
  })
})
