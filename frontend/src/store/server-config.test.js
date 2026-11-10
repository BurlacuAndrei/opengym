import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SERVER_CONFIG_KEY,
  getServerConfig,
  getServerUrl,
  saveServerConfig,
  clearServerConfig,
  normalizeServerUrl,
  verifyServer,
  isServerSupported,
} from '../lib/server-config.js'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerSection } from '../views/Settings.jsx'
import { t } from '../lib/i18n.js'

function createLocalStorage(initial = {}) {
  let store = { ...initial }
  return {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store },
  }
}

describe('server-config storage and persistence', () => {
  let mockStorage

  beforeEach(() => {
    mockStorage = createLocalStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to null and empty string when nothing stored', () => {
    expect(getServerConfig()).toBeNull()
    expect(getServerUrl()).toBe('')
  })

  it('persists and retrieves server config in localStorage', () => {
    const config = { url: 'https://gym.example.com', rpId: 'gym.example.com', native: { rpId: 'gym.example.com' } }
    saveServerConfig(config)

    expect(mockStorage.setItem).toHaveBeenCalledWith(SERVER_CONFIG_KEY, JSON.stringify(config))
    expect(getServerConfig()).toEqual(config)
    expect(getServerUrl()).toBe('https://gym.example.com')
  })

  it('clearServerConfig removes item from localStorage', () => {
    saveServerConfig({ url: 'https://gym.example.com' })
    clearServerConfig()

    expect(mockStorage.removeItem).toHaveBeenCalledWith(SERVER_CONFIG_KEY)
    expect(getServerConfig()).toBeNull()
    expect(getServerUrl()).toBe('')
  })

  it('saveServerConfig with falsy value clears storage', () => {
    saveServerConfig({ url: 'https://gym.example.com' })
    saveServerConfig(null)
    expect(getServerConfig()).toBeNull()
  })

  it('handles invalid JSON in localStorage gracefully without crashing', () => {
    mockStorage.getItem.mockReturnValue('invalid-json{')
    expect(getServerConfig()).toBeNull()
    expect(getServerUrl()).toBe('')
  })
})

describe('server URL normalization & validation', () => {
  it('identifies blank and whitespace-only URLs as removed', () => {
    expect(normalizeServerUrl('')).toEqual({ ok: true, removed: true, url: '' })
    expect(normalizeServerUrl('   ')).toEqual({ ok: true, removed: true, url: '' })
    expect(normalizeServerUrl(null)).toEqual({ ok: true, removed: true, url: '' })
    expect(normalizeServerUrl(undefined)).toEqual({ ok: true, removed: true, url: '' })
  })

  it('rejects non-HTTPS URLs with clear message', () => {
    const httpRes = normalizeServerUrl('http://gym.example.com')
    expect(httpRes.ok).toBe(false)
    expect(httpRes.error).toBe(t('Server URL must use HTTPS'))

    const ftpRes = normalizeServerUrl('ftp://gym.example.com')
    expect(ftpRes.ok).toBe(false)
    expect(ftpRes.error).toBe(t('Server URL must use HTTPS'))

    const noSchemeRes = normalizeServerUrl('gym.example.com')
    expect(noSchemeRes.ok).toBe(false)
    expect(noSchemeRes.error).toBe(t('Server URL must use HTTPS'))
  })

  it('normalizes valid HTTPS URLs by cleaning trailing slashes and subpaths', () => {
    const res1 = normalizeServerUrl('https://gym.example.com/')
    expect(res1).toEqual({ ok: true, url: 'https://gym.example.com' })

    const res2 = normalizeServerUrl('https://example.com/opengym/')
    expect(res2).toEqual({ ok: true, url: 'https://example.com/opengym' })

    const res3 = normalizeServerUrl('https://example.com/api/config')
    expect(res3).toEqual({ ok: true, url: 'https://example.com' })
  })

  it('rejects malformed HTTPS URLs', () => {
    const res = normalizeServerUrl('https://')
    expect(res.ok).toBe(false)
    expect(res.error).toBe(t('Invalid or unreachable openGym server'))
  })
})

describe('verifyServer verification outcomes', () => {
  let mockStorage

  beforeEach(() => {
    mockStorage = createLocalStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('blank URL removes server config and returns removed: true (local-only mode)', async () => {
    saveServerConfig({ url: 'https://previous.server.com' })
    const res = await verifyServer('')

    expect(res).toEqual({ ok: true, removed: true, config: null })
    expect(getServerConfig()).toBeNull()
  })

  it('rejects non-HTTPS before making any network request', async () => {
    const fetchSpy = vi.fn()
    const res = await verifyServer('http://insecure.server.com', { fetchFn: fetchSpy })

    expect(res.ok).toBe(false)
    expect(res.error).toBe(t('Server URL must use HTTPS'))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getServerConfig()).toBeNull()
  })

  it('rejects unreachable server when fetch rejects (network error/DNS failure)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('Failed to fetch'))
    const res = await verifyServer('https://down.server.com', { fetchFn: fetchSpy })

    expect(res.ok).toBe(false)
    expect(res.error).toBe(t('Invalid or unreachable openGym server'))
    expect(fetchSpy).toHaveBeenCalledWith('https://down.server.com/api/config', expect.any(Object))
    expect(getServerConfig()).toBeNull()
  })

  it('rejects invalid server when response status is not 200 (e.g. 404, 500)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    })
    const res = await verifyServer('https://wrong.server.com', { fetchFn: fetchSpy })

    expect(res.ok).toBe(false)
    expect(res.error).toBe(t('Invalid or unreachable openGym server'))
    expect(getServerConfig()).toBeNull()
  })

  it('rejects invalid server when response is not valid JSON', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('SyntaxError: Unexpected token < in JSON') },
    })
    const res = await verifyServer('https://html.server.com', { fetchFn: fetchSpy })

    expect(res.ok).toBe(false)
    expect(res.error).toBe(t('Invalid or unreachable openGym server'))
    expect(getServerConfig()).toBeNull()
  })

  it('rejects server missing native flag with "server needs updating"', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        invite_only: false,
        // no native field! (older openGym server)
      }),
    })
    const res = await verifyServer('https://old.server.com', { fetchFn: fetchSpy })

    expect(res.ok).toBe(false)
    expect(res.error).toBe(t('Server needs updating'))
    expect(res.error.toLowerCase()).toContain('server needs updating')
    expect(getServerConfig()).toBeNull()
  })

  it('rejects server when native field is null/falsy', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        invite_only: false,
        native: null,
      }),
    })
    const res = await verifyServer('https://old.server.com', { fetchFn: fetchSpy })

    expect(res.ok).toBe(false)
    expect(res.error).toBe(t('Server needs updating'))
    expect(getServerConfig()).toBeNull()
  })

  it('persists server config and returns ok: true when native flag is present', async () => {
    const nativeConfig = { rpId: 'gym.duartesantos.ch' }
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        invite_only: false,
        native: nativeConfig,
      }),
    })

    const res = await verifyServer('https://gym.duartesantos.ch/', { fetchFn: fetchSpy })

    expect(res.ok).toBe(true)
    expect(res.config).toEqual({
      url: 'https://gym.duartesantos.ch',
      native: nativeConfig,
      rpId: 'gym.duartesantos.ch',
    })
    expect(getServerConfig()).toEqual(res.config)
    expect(getServerUrl()).toBe('https://gym.duartesantos.ch')
  })

  it('does not persist when save: false option is passed', async () => {
    const nativeConfig = { rpId: 'gym.example.com' }
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        invite_only: false,
        native: nativeConfig,
      }),
    })

    const res = await verifyServer('https://gym.example.com', { fetchFn: fetchSpy, save: false })

    expect(res.ok).toBe(true)
    expect(getServerConfig()).toBeNull()
  })
})

describe('platform visibility constraints (Android only: MOBILE && IS_ANDROID)', () => {
  it('is supported only when both MOBILE and IS_ANDROID are true', () => {
    expect(isServerSupported({ mobile: true, isAndroid: true })).toBe(true)
  })

  it('is hidden on iOS native app (!IS_ANDROID)', () => {
    expect(isServerSupported({ mobile: true, isAndroid: false })).toBe(false)
  })

  it('is hidden on Android web browser (!MOBILE)', () => {
    expect(isServerSupported({ mobile: false, isAndroid: true })).toBe(false)
  })

  it('is hidden on Desktop web (!MOBILE && !IS_ANDROID)', () => {
    expect(isServerSupported({ mobile: false, isAndroid: false })).toBe(false)
  })
})

describe('ServerSection UI component structure', () => {
  beforeEach(() => {
    const mockStorage = createLocalStorage({
      [SERVER_CONFIG_KEY]: JSON.stringify({ url: 'https://active.server.com' }),
    })
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    })
  })

  it('renders Section with Server title, input field, and connected status', () => {
    const toast = vi.fn()
    const html = renderToStaticMarkup(React.createElement(ServerSection, { toast }))

    expect(html).toContain(t('Server'))
    expect(html).toContain('https://active.server.com')
    expect(html).toContain(t('Disconnect'))
    expect(html).toContain(t('Connected to {0}', 'https://active.server.com'))
  })

  it('renders unconfigured state when no server is saved', () => {
    clearServerConfig()
    const toast = vi.fn()
    const html = renderToStaticMarkup(React.createElement(ServerSection, { toast }))

    expect(html).toContain(t('Server'))
    expect(html).toContain(t('Self-hosted openGym server for syncing and passkeys.'))
    expect(html).not.toContain(t('Disconnect'))
  })
})
