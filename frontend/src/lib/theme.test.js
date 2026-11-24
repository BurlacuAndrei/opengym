import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('theme / SystemBars integration', () => {
  let origDocument
  let origWindow

  beforeEach(() => {
    origDocument = globalThis.document
    origWindow = globalThis.window
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('@capacitor/core')
    vi.resetModules()
    if (origDocument === undefined) delete globalThis.document
    else globalThis.document = origDocument
    if (origWindow === undefined) delete globalThis.window
    else globalThis.window = origWindow
  })

  function setupDom(matches = false) {
    const meta = { content: '#111315' }
    const de = { dataset: {} }
    const listeners = new Set()
    const mql = {
      matches,
      addEventListener: vi.fn((ev, cb) => {
        if (ev === 'change') listeners.add(cb)
      }),
      removeEventListener: vi.fn((ev, cb) => {
        if (ev === 'change') listeners.delete(cb)
      })
    }
    globalThis.document = {
      documentElement: de,
      querySelector: vi.fn(sel => (sel === 'meta[name="theme-color"]' ? meta : null))
    }
    globalThis.window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: vi.fn(() => mql)
    }
    return { de, meta, mql, listeners }
  }

  it('safely skips SystemBars in SSR/Node when document/window are absent and isNativePlatform is false', async () => {
    delete globalThis.document
    delete globalThis.window
    const setStyle = vi.fn(() => Promise.resolve())
    const registerPlugin = vi.fn(() => ({ setStyle }))
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
        isPluginAvailable: () => false
      },
      registerPlugin
    }))

    const { applyTheme, syncThemeEffect } = await import('./theme.js')
    expect(applyTheme('light')).toBe('light')
    expect(applyTheme(undefined)).toBe('dark')
    expect(syncThemeEffect('system', 'lime')).toBeUndefined()
    expect(registerPlugin).not.toHaveBeenCalled()
    expect(setStyle).not.toHaveBeenCalled()
  })

  it('skips SystemBars on web and iOS platforms', async () => {
    setupDom(false)
    const setStyle = vi.fn(() => Promise.resolve())
    const registerPlugin = vi.fn(() => ({ setStyle }))

    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
        isPluginAvailable: () => true
      },
      registerPlugin
    }))
    let mod = await import('./theme.js')
    expect(mod.applyTheme('light')).toBe('light')
    expect(registerPlugin).not.toHaveBeenCalled()
    expect(setStyle).not.toHaveBeenCalled()

    vi.resetModules()
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        isPluginAvailable: () => true
      },
      registerPlugin
    }))
    mod = await import('./theme.js')
    expect(mod.applyTheme('dark')).toBe('dark')
    expect(registerPlugin).not.toHaveBeenCalled()
    expect(setStyle).not.toHaveBeenCalled()
  })

  it('calls SystemBars.setStyle on Android for light, dark, and undefined', async () => {
    const { de, meta } = setupDom(false)
    const setStyle = vi.fn(() => Promise.resolve())
    const registerPlugin = vi.fn(() => ({ setStyle }))
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        isPluginAvailable: name => name === 'SystemBars'
      },
      registerPlugin
    }))

    const { applyTheme } = await import('./theme.js')

    expect(applyTheme('light')).toBe('light')
    expect(de.dataset.theme).toBe('light')
    expect(meta.content).toBe('#F6F6F3')
    expect(setStyle).toHaveBeenNthCalledWith(1, { theme: 'light' })

    expect(applyTheme('dark')).toBe('dark')
    expect(de.dataset.theme).toBe('dark')
    expect(meta.content).toBe('#111315')
    expect(setStyle).toHaveBeenNthCalledWith(2, { theme: 'dark' })

    expect(applyTheme(undefined)).toBe('dark')
    expect(setStyle).toHaveBeenNthCalledWith(3, { theme: 'dark' })
    expect(registerPlugin).toHaveBeenCalledTimes(1)
    expect(registerPlugin).toHaveBeenCalledWith('SystemBars')
  })

  it('prefers pre-registered Capacitor.Plugins.SystemBars over registerPlugin', async () => {
    setupDom(false)
    const setStyle = vi.fn(() => Promise.resolve())
    const registerPlugin = vi.fn()
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        isPluginAvailable: () => false,
        Plugins: { SystemBars: { setStyle } }
      },
      registerPlugin
    }))

    const { applyTheme } = await import('./theme.js')
    expect(applyTheme('light')).toBe('light')
    expect(applyTheme('dark')).toBe('dark')
    expect(registerPlugin).not.toHaveBeenCalled()
    expect(setStyle).toHaveBeenNthCalledWith(1, { theme: 'light' })
    expect(setStyle).toHaveBeenNthCalledWith(2, { theme: 'dark' })
  })

  it('syncThemeEffect("system") syncs SystemBars on initial apply and matchMedia changes', async () => {
    const { de, meta, mql, listeners } = setupDom(false)
    const setStyle = vi.fn(() => Promise.resolve())
    const registerPlugin = vi.fn(() => ({ setStyle }))
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        isPluginAvailable: () => true
      },
      registerPlugin
    }))

    const { syncThemeEffect } = await import('./theme.js')
    const cleanup = syncThemeEffect('system', 'lime')

    expect(de.dataset.theme).toBe('light')
    expect(de.dataset.accent).toBe('lime')
    expect(meta.content).toBe('#F6F6F3')
    expect(setStyle).toHaveBeenNthCalledWith(1, { theme: 'light' })

    mql.matches = true
    for (const cb of listeners) cb({ matches: true })
    expect(de.dataset.theme).toBe('dark')
    expect(meta.content).toBe('#111315')
    expect(setStyle).toHaveBeenNthCalledWith(2, { theme: 'dark' })

    cleanup()
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1)
    expect(registerPlugin).toHaveBeenCalledTimes(1)
  })

  it('does not throw when SystemBars plugin is unavailable or setStyle rejects/throws', async () => {
    setupDom(false)
    const registerPlugin = vi.fn()
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        isPluginAvailable: () => false
      },
      registerPlugin
    }))

    let mod = await import('./theme.js')
    expect(() => mod.applyTheme('light')).not.toThrow()
    expect(registerPlugin).not.toHaveBeenCalled()

    vi.resetModules()
    const rejectingSetStyle = vi.fn(() => Promise.reject(new Error('native failure')))
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        isPluginAvailable: () => true
      },
      registerPlugin: () => ({ setStyle: rejectingSetStyle })
    }))

    mod = await import('./theme.js')
    expect(mod.applyTheme('dark')).toBe('dark')
    expect(rejectingSetStyle).toHaveBeenCalledWith({ theme: 'dark' })
    await Promise.resolve()

    vi.resetModules()
    const throwingSetStyle = vi.fn(() => {
      throw new Error('sync boom')
    })
    vi.doMock('@capacitor/core', () => ({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        isPluginAvailable: () => true
      },
      registerPlugin: () => ({ setStyle: throwingSetStyle })
    }))

    mod = await import('./theme.js')
    expect(() => mod.applyTheme('light')).not.toThrow()
    expect(mod.applyTheme('light')).toBe('light')
  })
})
