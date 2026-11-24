import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import PrivacySettings from './PrivacySettings.jsx'
import Settings from './Settings.jsx'
import { checkAndPromptCardioRecovery } from '../App.jsx'
import { loadStarterPlan } from '../sheets.jsx'
import { useStore, DEF } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

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

describe('Privacy Center, Unified Activity Settings & Boot Recovery (Issue #100)', () => {
  beforeEach(() => {
    useUI.getState().closeAll()
    useStore.getInitialState = () => useStore.getState()
    useStore.setState({ S: JSON.parse(JSON.stringify(DEF)), user: null, config: {} })
  })

  it('PrivacySettings renders OSM tiles, DEM elevation, Coach, and GPS Track Retention periods', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(PrivacySettings))
    )
    expect(html).toContain('OpenStreetMap Map Tiles')
    expect(html).toContain('DEM Elevation Lookup')
    expect(html).toContain('AI Coach')
    expect(html).not.toMatch(/<span class="lrow-i"[^>]*><\/span>/)
    expect(html).toMatch(/<span class="lrow-i"[^>]*><svg class="icn[^"]*"[^>]*>[\s\S]*?<\/svg><\/span><span class="lrow-m"><span class="lrow-t">Server Sync<\/span>/)
    expect(html).toMatch(/<span class="lrow-i"[^>]*><svg class="icn[^"]*"[^>]*>[\s\S]*?<\/svg><\/span><span class="lrow-m"><span class="lrow-t">Cardio GPS &amp; Location<\/span>/)
    expect(html).toContain('GPS Track Retention')
    expect(html).toContain('Never')
    expect(html).toContain('1 Year')
    expect(html).toContain('2 Years')
    expect(html).toContain('5 Years')
  })

  it('Settings renders Privacy, Maps & Track Retention row, unified During an Activity section, and Load starter plan', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(Settings))
    )
    expect(html).toContain('Privacy, Maps &amp; Track Retention')
    expect(html).toContain('During an Activity')
    expect(html).toContain('Voice Split &amp; Interval Cues (TTS)')
    expect(html).toContain('Audio ducking')
    expect(html).toContain('Load starter plan')
  })

  it('loadStarterPlan opens 4-template picker when called without args, and applies directly with an id', () => {
    loadStarterPlan()
    const sheetRender = useUI.getState().sheets.at(-1)?.render
    expect(typeof sheetRender).toBe('function')
    const sheetHtml = renderToStaticMarkup(sheetRender(() => {}))
    expect(sheetHtml).toContain('data-testid="starter-sheet-hybrid"')
    expect(sheetHtml).toContain('data-testid="starter-sheet-endurance"')
    expect(sheetHtml).toContain('data-testid="starter-sheet-ppl"')
    expect(sheetHtml).toContain('data-testid="starter-sheet-mobility"')

    useUI.getState().closeAll()
    loadStarterPlan('hybrid')
    expect(useStore.getState().S.routines.length).toBeGreaterThan(0)
    expect(useStore.getState().S.cardioPlans.length).toBeGreaterThan(0)
  })

  it('checkAndPromptCardioRecovery prompts restore/discard on boot when recovery log exists and no-ops when null', async () => {
    const openSheetFn = vi.fn()
    const none = await checkAndPromptCardioRecovery({
      checkFn: async () => null,
      openSheetFn
    })
    expect(none).toBeNull()
    expect(openSheetFn).not.toHaveBeenCalled()

    const recoveredSession = {
      type: 'run',
      durationMs: 900000,
      points: [{ lat: 47.6, lon: -122.3 }, { lat: 47.61, lon: -122.31 }]
    }
    const found = await checkAndPromptCardioRecovery({
      checkFn: async () => recoveredSession,
      openSheetFn
    })
    expect(found).toBe(recoveredSession)
    expect(openSheetFn).toHaveBeenCalledTimes(1)
    const promptHtml = renderToStaticMarkup(openSheetFn.mock.calls[0][0](() => {}))
    expect(promptHtml).toContain('Recover interrupted cardio?')
    expect(promptHtml).toContain('Restore &amp; Save')
    expect(promptHtml).toContain('Discard')
  })
})
