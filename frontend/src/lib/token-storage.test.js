import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getToken,
  setToken,
  clearToken,
  getByokKey,
  setByokKey,
  clearByokKey,
  setStorageBackend,
  getStorageBackend,
  createMemoryStorageBackend,
  createNativeStorageBackend,
  DEFAULT_TOKEN_KEY,
  BYOK_KEY,
  BYOK_COACH_API_KEY
} from './token-storage.js'
import { Capacitor } from '@capacitor/core'

describe('token-storage', () => {
  beforeEach(async () => {
    // Reset to default backend and clean default memory store
    setStorageBackend(null)
    await clearToken()
    await clearByokKey()
  })

  describe('default in-memory backend', () => {
    it('returns null when no token is stored', async () => {
      const token = await getToken()
      expect(token).toBeNull()
    })

    it('stores and retrieves a token with default key', async () => {
      await setToken('jwt-sample-token')
      const token = await getToken()
      expect(token).toBe('jwt-sample-token')
    })

    it('clears stored token', async () => {
      await setToken('jwt-sample-token')
      await clearToken()
      const token = await getToken()
      expect(token).toBeNull()
    })

    it('supports custom keys independently', async () => {
      await setToken('token-a', 'key_a')
      await setToken('token-b', 'key_b')

      expect(await getToken('key_a')).toBe('token-a')
      expect(await getToken('key_b')).toBe('token-b')
      expect(await getToken()).toBeNull()

      await clearToken('key_a')
      expect(await getToken('key_a')).toBeNull()
      expect(await getToken('key_b')).toBe('token-b')
    })

    it('converts non-string values to string', async () => {
      await setToken(12345)
      expect(await getToken()).toBe('12345')
    })

    it('clears token when setToken is called with null or undefined', async () => {
      await setToken('existing-token')
      await setToken(null)
      expect(await getToken()).toBeNull()

      await setToken('existing-token')
      await setToken(undefined)
      expect(await getToken()).toBeNull()
    })
  })

  describe('createMemoryStorageBackend', () => {
    it('initializes with seed data', async () => {
      const backend = createMemoryStorageBackend({
        [DEFAULT_TOKEN_KEY]: 'seed-token',
        other_key: 'seed-other'
      })

      expect(await backend.getToken()).toBe('seed-token')
      expect(await backend.getToken('other_key')).toBe('seed-other')
    })

    it('keeps instances isolated from each other', async () => {
      const b1 = createMemoryStorageBackend()
      const b2 = createMemoryStorageBackend()

      await b1.setToken('token-1')
      expect(await b1.getToken()).toBe('token-1')
      expect(await b2.getToken()).toBeNull()
    })

    it('clears all tokens when clearToken is called with empty key', async () => {
      const backend = createMemoryStorageBackend({ k1: 'v1', k2: 'v2' })
      await backend.clearToken('')
      expect(await backend.getToken('k1')).toBeNull()
      expect(await backend.getToken('k2')).toBeNull()
    })
  })

  describe('setStorageBackend seam', () => {
    it('redirects operations to injected backend', async () => {
      const mockBackend = {
        getToken: vi.fn().mockResolvedValue('mock-token'),
        setToken: vi.fn().mockResolvedValue(undefined),
        clearToken: vi.fn().mockResolvedValue(undefined)
      }

      setStorageBackend(mockBackend)

      const token = await getToken('test-key')
      expect(token).toBe('mock-token')
      expect(mockBackend.getToken).toHaveBeenCalledWith('test-key')

      await setToken('new-value', 'test-key')
      expect(mockBackend.setToken).toHaveBeenCalledWith('new-value', 'test-key')

      await clearToken('test-key')
      expect(mockBackend.clearToken).toHaveBeenCalledWith('test-key')
    })

    it('restores default backend when reset to null', async () => {
      const mockBackend = {
        getToken: vi.fn().mockResolvedValue('from-mock'),
        setToken: vi.fn(),
        clearToken: vi.fn()
      }

      setStorageBackend(mockBackend)
      expect(await getToken()).toBe('from-mock')

      setStorageBackend(null)
      expect(await getToken()).toBeNull()
    })
  })

  describe('createNativeStorageBackend', () => {
    it('interacts with native plugin for set, get, and clear', async () => {
      const plugin = {
        getToken: vi.fn().mockResolvedValue({ token: 'native-secret' }),
        setToken: vi.fn().mockResolvedValue({ success: true }),
        clearToken: vi.fn().mockResolvedValue({ success: true })
      }

      const backend = createNativeStorageBackend(plugin)

      await backend.setToken('native-secret', 'custom_key')
      expect(plugin.setToken).toHaveBeenCalledWith({ token: 'native-secret', key: 'custom_key' })

      const token = await backend.getToken('custom_key')
      expect(token).toBe('native-secret')
      expect(plugin.getToken).toHaveBeenCalledWith({ key: 'custom_key' })

      await backend.clearToken('custom_key')
      expect(plugin.clearToken).toHaveBeenCalledWith({ key: 'custom_key' })
    })

    it('reads value field if token field is absent in plugin response', async () => {
      const plugin = {
        getToken: vi.fn().mockResolvedValue({ value: 'val-secret' }),
        setToken: vi.fn(),
        clearToken: vi.fn()
      }

      const backend = createNativeStorageBackend(plugin)
      expect(await backend.getToken()).toBe('val-secret')
    })

    it('returns null when plugin returns empty or null response', async () => {
      const plugin = {
        getToken: vi.fn().mockResolvedValue({ token: null }),
        setToken: vi.fn(),
        clearToken: vi.fn()
      }

      const backend = createNativeStorageBackend(plugin)
      expect(await backend.getToken()).toBeNull()
    })

    it('calls plugin.clearToken if setToken is called with null or undefined', async () => {
      const plugin = {
        getToken: vi.fn(),
        setToken: vi.fn(),
        clearToken: vi.fn().mockResolvedValue({ success: true })
      }

      const backend = createNativeStorageBackend(plugin)
      await backend.setToken(null, 'test_key')
      expect(plugin.clearToken).toHaveBeenCalledWith({ key: 'test_key' })
      expect(plugin.setToken).not.toHaveBeenCalled()
    })
  })

  describe('platform detection', () => {
    it('uses native backend when platform is native Android', () => {
      vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
      vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android')

      const backend = getStorageBackend()
      expect(typeof backend.getToken).toBe('function')
      expect(typeof backend.setToken).toBe('function')
      expect(typeof backend.clearToken).toBe('function')

      vi.restoreAllMocks()
    })
  })

  describe('BYOK Coach API key storage', () => {
    it('uses dedicated key byok_coach_api_key', () => {
      expect(BYOK_KEY).toBe('byok_coach_api_key')
      expect(BYOK_COACH_API_KEY).toBe('byok_coach_api_key')
    })

    it('returns null when no BYOK key is stored', async () => {
      const key = await getByokKey()
      expect(key).toBeNull()
    })

    it('stores and retrieves BYOK API key in memory backend', async () => {
      await setByokKey('sk-ant-api03-test-secret-key')
      const retrieved = await getByokKey()
      expect(retrieved).toBe('sk-ant-api03-test-secret-key')
    })

    it('clears BYOK key without affecting auth token', async () => {
      await setToken('auth-jwt-123')
      await setByokKey('sk-ant-api03-test-secret-key')

      await clearByokKey()
      expect(await getByokKey()).toBeNull()
      expect(await getToken()).toBe('auth-jwt-123')
    })

    it('clearing auth token does not affect BYOK key', async () => {
      await setToken('auth-jwt-123')
      await setByokKey('sk-ant-api03-test-secret-key')

      await clearToken()
      expect(await getToken()).toBeNull()
      expect(await getByokKey()).toBe('sk-ant-api03-test-secret-key')
    })

    it('clears BYOK key when setByokKey is called with null or undefined', async () => {
      await setByokKey('sk-test')
      await setByokKey(null)
      expect(await getByokKey()).toBeNull()

      await setByokKey('sk-test')
      await setByokKey(undefined)
      expect(await getByokKey()).toBeNull()
    })

    it('interacts with native plugin using byok_coach_api_key', async () => {
      const plugin = {
        getToken: vi.fn().mockResolvedValue({ token: 'sk-native-key' }),
        setToken: vi.fn().mockResolvedValue({ success: true }),
        clearToken: vi.fn().mockResolvedValue({ success: true })
      }
      const backend = createNativeStorageBackend(plugin)
      setStorageBackend(backend)

      await setByokKey('sk-native-key')
      expect(plugin.setToken).toHaveBeenCalledWith({ token: 'sk-native-key', key: 'byok_coach_api_key' })

      const val = await getByokKey()
      expect(val).toBe('sk-native-key')
      expect(plugin.getToken).toHaveBeenCalledWith({ key: 'byok_coach_api_key' })

      await clearByokKey()
      expect(plugin.clearToken).toHaveBeenCalledWith({ key: 'byok_coach_api_key' })
    })

    it('verifies key isolation: key is never stored in localStorage, application state, backups, or sync payloads', async () => {
      const mockLocalStorage = {
        _store: {},
        getItem(k) { return this._store[k] ?? null },
        setItem(k, v) { this._store[k] = String(v) },
        removeItem(k) { delete this._store[k] },
        clear() { this._store = {} }
      }
      const origLocalStorage = globalThis.localStorage
      Object.defineProperty(globalThis, 'localStorage', {
        value: mockLocalStorage,
        configurable: true,
        writable: true
      })

      try {
        const secret = 'sk-super-secret-coach-key'
        await setByokKey(secret)

        // 1. Verify localStorage is completely untouched
        expect(mockLocalStorage._store['byok_coach_api_key']).toBeUndefined()
        expect(mockLocalStorage.getItem('byok_coach_api_key')).toBeNull()
        expect(Object.keys(mockLocalStorage._store)).toHaveLength(0)

        // 2. Mock app state, backup, and sync payloads
        const appState = { exercises: [], workouts: [], settings: {} }
        const syncPayload = { clientState: appState, lastSynced: Date.now() }
        const backupPayload = JSON.stringify({ state: appState, version: 1 })

        expect(JSON.stringify(appState)).not.toContain(secret)
        expect(JSON.stringify(syncPayload)).not.toContain(secret)
        expect(backupPayload).not.toContain(secret)
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: origLocalStorage,
          configurable: true,
          writable: true
        })
      }
    })

    it('works with createMemoryStorageBackend initial seed for BYOK key', async () => {
      const seededBackend = createMemoryStorageBackend({
        [BYOK_KEY]: 'sk-seeded-key',
        [DEFAULT_TOKEN_KEY]: 'auth-jwt-seed'
      })
      setStorageBackend(seededBackend)

      expect(await getByokKey()).toBe('sk-seeded-key')
      expect(await getToken()).toBe('auth-jwt-seed')
    })
  })
})
