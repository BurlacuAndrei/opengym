import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  nativeTransport,
  createNativeTransport,
  resolveUrl,
  isOffline,
  isAuthError,
  isConflictError
} from './native-transport.js'
import { api, setTransport, resetTransport } from './api.js'
import { SERVER_CONFIG_KEY, saveServerConfig, clearServerConfig } from './server-config.js'
import { setToken, clearToken, setStorageBackend, createMemoryStorageBackend } from './token-storage.js'

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

describe('nativeTransport', () => {
  let memoryStorage
  let origFetch
  let mockStorage

  beforeEach(() => {
    origFetch = globalThis.fetch
    mockStorage = createLocalStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    })
    memoryStorage = createMemoryStorageBackend()
    setStorageBackend(memoryStorage)
    clearServerConfig()
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    clearServerConfig()
    resetTransport()
    vi.restoreAllMocks()
  })

  describe('resolveUrl', () => {
    it('returns original path when serverUrl is empty', () => {
      expect(resolveUrl('/api/workouts', '')).toBe('/api/workouts')
      expect(resolveUrl('/api/workouts', null)).toBe('/api/workouts')
    })

    it('combines serverUrl without trailing slash and path with leading slash', () => {
      expect(resolveUrl('/api/workouts', 'https://gym.example.com')).toBe('https://gym.example.com/api/workouts')
    })

    it('avoids double slashes when serverUrl has trailing slash', () => {
      expect(resolveUrl('/api/workouts', 'https://gym.example.com/')).toBe('https://gym.example.com/api/workouts')
    })

    it('adds leading slash if path lacks one', () => {
      expect(resolveUrl('api/workouts', 'https://gym.example.com')).toBe('https://gym.example.com/api/workouts')
      expect(resolveUrl('api/workouts', 'https://gym.example.com/')).toBe('https://gym.example.com/api/workouts')
    })

    it('preserves already absolute URLs', () => {
      expect(resolveUrl('https://custom.com/data', 'https://gym.example.com')).toBe('https://custom.com/data')
      expect(resolveUrl('http://custom.com/data', 'https://gym.example.com')).toBe('http://custom.com/data')
    })

    it('preserves query strings and URL hashes', () => {
      expect(resolveUrl('/api/sync?since=123#summary', 'https://gym.example.com'))
        .toBe('https://gym.example.com/api/sync?since=123#summary')
    })
  })

  describe('mode switching', () => {
    it('defaults to relative fetch with no Bearer token when no server URL configured (web/local-only mode)', async () => {
      await setToken('secret-token-123')
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ synced: true })
      })
      globalThis.fetch = fetchSpy

      const res = await nativeTransport('/api/data', { method: 'GET' })

      expect(res).toEqual({ synced: true })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [calledUrl, calledOpts] = fetchSpy.mock.calls[0]
      expect(calledUrl).toBe('/api/data')
      expect(calledOpts.headers['Authorization']).toBeUndefined()
      expect(calledOpts.headers['Content-Type']).toBe('application/json')
    })

    it('switches to absolute URL and injects Bearer token when server URL is set', async () => {
      saveServerConfig({ url: 'https://gym.example.com' })
      await setToken('secret-token-123')
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ state: { _ts: 10 } })
      })
      globalThis.fetch = fetchSpy

      const res = await nativeTransport('/api/data')

      expect(res).toEqual({ state: { _ts: 10 } })
      const [calledUrl, calledOpts] = fetchSpy.mock.calls[0]
      expect(calledUrl).toBe('https://gym.example.com/api/data')
      expect(calledOpts.headers['Authorization']).toBe('Bearer secret-token-123')
    })

    it('switches back to relative URL without Bearer token when server config is cleared', async () => {
      saveServerConfig({ url: 'https://gym.example.com' })
      await setToken('secret-token-123')

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true })
      })
      globalThis.fetch = fetchSpy

      await nativeTransport('/api/test')
      expect(fetchSpy.mock.calls[0][0]).toBe('https://gym.example.com/api/test')
      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe('Bearer secret-token-123')

      // Clear server mode
      clearServerConfig()

      await nativeTransport('/api/test')
      expect(fetchSpy.mock.calls[1][0]).toBe('/api/test')
      expect(fetchSpy.mock.calls[1][1].headers['Authorization']).toBeUndefined()
    })

    it('operates identically when invoked via api() facade', async () => {
      saveServerConfig({ url: 'https://api.opengym.app' })
      await setToken('tok-456')

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ user: 'john' })
      })
      globalThis.fetch = fetchSpy

      const res = await api('/api/me')
      expect(res).toEqual({ user: 'john' })
      expect(fetchSpy).toHaveBeenCalledWith('https://api.opengym.app/api/me', {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer tok-456'
        }
      })
    })
  })

  describe('bearer header injection', () => {
    it('injects Bearer token in server mode when token is present', async () => {
      saveServerConfig({ url: 'https://mygym.org' })
      await setToken('my-jwt-token')

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({})
      })
      globalThis.fetch = fetchSpy

      await nativeTransport('/api/status')
      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe('Bearer my-jwt-token')
    })

    it('omits Bearer token in server mode when no token is stored', async () => {
      saveServerConfig({ url: 'https://mygym.org' })
      await clearToken()

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({})
      })
      globalThis.fetch = fetchSpy

      await nativeTransport('/api/status')
      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBeUndefined()
    })

    it('preserves and merges custom headers from opts.headers', async () => {
      saveServerConfig({ url: 'https://mygym.org' })
      await setToken('token-abc')

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({})
      })
      globalThis.fetch = fetchSpy

      await nativeTransport('/api/status', {
        headers: {
          'X-Client-Version': '1.0.0',
          'Accept': 'application/json'
        }
      })

      const headers = fetchSpy.mock.calls[0][1].headers
      expect(headers['Authorization']).toBe('Bearer token-abc')
      expect(headers['X-Client-Version']).toBe('1.0.0')
      expect(headers['Accept']).toBe('application/json')
      expect(headers['Content-Type']).toBe('application/json')
    })

    it('allows caller explicit Authorization header to override stored token', async () => {
      saveServerConfig({ url: 'https://mygym.org' })
      await setToken('stored-token')

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({})
      })
      globalThis.fetch = fetchSpy

      await nativeTransport('/api/status', {
        headers: {
          'Authorization': 'Bearer custom-token-override'
        }
      })

      const headers = fetchSpy.mock.calls[0][1].headers
      expect(headers['Authorization']).toBe('Bearer custom-token-override')
    })

    it('supports Headers instance in opts.headers', async () => {
      saveServerConfig({ url: 'https://mygym.org' })
      await setToken('tok-inst')

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({})
      })
      globalThis.fetch = fetchSpy

      const customHeaders = new Headers()
      customHeaders.append('X-Foo', 'bar')

      await nativeTransport('/api/status', { headers: customHeaders })
      const headers = fetchSpy.mock.calls[0][1].headers
      expect(headers['Authorization']).toBe('Bearer tok-inst')
      expect(headers['x-foo'] ?? headers['X-Foo']).toBe('bar')
    })
  })

  describe('error classification: offline vs 401 vs 409', () => {
    it('classifies fetch rejection (network failure / offline) with status 0, offline true, and null state', async () => {
      const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
      globalThis.fetch = fetchSpy

      try {
        await nativeTransport('/api/data')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err.status).toBe(0)
        expect(err.offline).toBe(true)
        expect(err.data).toBeNull()
        expect(err.state).toBeNull()
        expect(err.serverState).toBeNull()
        expect(isOffline(err)).toBe(true)
        expect(isAuthError(err)).toBe(false)
        expect(isConflictError(err)).toBe(false)
      }
    })

    it('classifies response with status 0 as network error', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        status: 0,
        ok: false
      })
      globalThis.fetch = fetchSpy

      try {
        await nativeTransport('/api/data')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err.status).toBe(0)
        expect(err.offline).toBe(true)
        expect(isOffline(err)).toBe(true)
      }
    })

    it('classifies 401 Unauthorized, exposing status and data, offline false', async () => {
      const errorPayload = { error: 'Session expired', reason: 'token_expired' }
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => errorPayload
      })
      globalThis.fetch = fetchSpy

      try {
        await nativeTransport('/api/data')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err.status).toBe(401)
        expect(err.offline).toBe(false)
        expect(err.data).toEqual(errorPayload)
        expect(err.message).toBe('Session expired')
        expect(isOffline(err)).toBe(false)
        expect(isAuthError(err)).toBe(true)
        expect(isConflictError(err)).toBe(false)
      }
    })

    it('classifies 409 Conflict, exposing status, data, state, and serverState', async () => {
      const conflictPayload = {
        error: 'Conflict: server has newer data',
        state: { _ts: 200, exercises: ['squat'] }
      }
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => conflictPayload
      })
      globalThis.fetch = fetchSpy

      try {
        await nativeTransport('/api/data', { method: 'PUT', body: '{}' })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err.status).toBe(409)
        expect(err.offline).toBe(false)
        expect(err.data).toEqual(conflictPayload)
        expect(err.state).toEqual(conflictPayload.state)
        expect(err.serverState).toEqual(conflictPayload.state)
        expect(err.message).toBe('Conflict: server has newer data')
        expect(isOffline(err)).toBe(false)
        expect(isAuthError(err)).toBe(false)
        expect(isConflictError(err)).toBe(true)
      }
    })

    it('handles other HTTP error statuses (e.g. 500) with offline false', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal Server Error' })
      })
      globalThis.fetch = fetchSpy

      try {
        await nativeTransport('/api/data')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err.status).toBe(500)
        expect(err.offline).toBe(false)
        expect(err.message).toBe('Internal Server Error')
        expect(isOffline(err)).toBe(false)
        expect(isAuthError(err)).toBe(false)
        expect(isConflictError(err)).toBe(false)
      }
    })
  })

  describe('createNativeTransport with custom dependency injection', () => {
    it('uses injected getServerUrl, getToken, and fetchFn', async () => {
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ custom: true })
      })

      const transport = createNativeTransport({
        getServerUrl: () => 'https://dep-injected.server',
        getToken: async () => 'dep-token-999',
        fetchFn: customFetch
      })

      const res = await transport('/custom/path', { method: 'POST' })
      expect(res).toEqual({ custom: true })
      expect(customFetch).toHaveBeenCalledWith(
        'https://dep-injected.server/custom/path',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer dep-token-999'
          })
        })
      )
    })
  })
})
