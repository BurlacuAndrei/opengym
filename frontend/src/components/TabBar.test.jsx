import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TabBar from './TabBar.jsx'
import { useStore, DEF } from '../store/useStore.js'

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/home' })
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

vi.mock('../lib/cardio-recording.js', () => ({
  getCardioRecorder: () => ({ getState: () => ({}), subscribe: () => () => {} }),
  setCardioStore: vi.fn(),
  RECORDING_STATUS: { RECORDING: 'recording', PAUSED: 'paused' }
}))

vi.mock('../lib/flow-player.js', () => ({
  getActiveFlow: () => null,
  subscribeActiveFlow: () => () => {}
}))

vi.mock('./StartHubSheet.jsx', () => ({ openStartHubSheet: vi.fn() }))

if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} })
  }
}

describe('TabBar responsive shell (issue #113)', () => {
  beforeEach(() => {
    useStore.getInitialState = () => useStore.getState()
    useStore.setState({ S: JSON.parse(JSON.stringify(DEF)), user: { name: 'test' }, config: {} })
  })

  const html = () => renderToStaticMarkup(React.createElement(TabBar))

  it('renders #tabbar plus #sidebar with all 5 nav links and a Start button', () => {
    const out = html()
    expect(out).toContain('id="tabbar"')
    const sidebar = out.slice(out.indexOf('id="sidebar"'))
    for (const label of ['Home', 'Plan', 'Stats', 'Library', 'Settings']) {
      expect(sidebar).toContain('>' + label + '</span>')
    }
    expect(out.match(/>Start<\/span>/g)).toHaveLength(2)
  })

  it('labels both Start buttons Resume when a workout is active', () => {
    useStore.setState({ S: { ...JSON.parse(JSON.stringify(DEF)), active: { name: 'Push Day' } } })
    const out = html()
    expect(out.match(/>Resume<\/span>/g)).toHaveLength(2)
    expect(out).not.toContain('>Start</span>')
  })
})
