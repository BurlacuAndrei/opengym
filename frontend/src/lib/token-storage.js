import { Capacitor, registerPlugin } from '@capacitor/core'

export const DEFAULT_TOKEN_KEY = 'auth_token'

export function createMemoryStorageBackend(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    async getToken(key = DEFAULT_TOKEN_KEY) {
      return store.has(key) ? store.get(key) : null
    },
    async setToken(token, key = DEFAULT_TOKEN_KEY) {
      if (token === null || token === undefined) {
        store.delete(key)
      } else {
        store.set(key, String(token))
      }
    },
    async clearToken(key = DEFAULT_TOKEN_KEY) {
      if (key) {
        store.delete(key)
      } else {
        store.clear()
      }
    }
  }
}

export function createNativeStorageBackend(plugin) {
  const getPlugin = () => plugin || registerPlugin('NativePasskey')
  return {
    async getToken(key = DEFAULT_TOKEN_KEY) {
      const p = getPlugin()
      const res = await p.getToken({ key })
      return res?.token ?? res?.value ?? null
    },
    async setToken(token, key = DEFAULT_TOKEN_KEY) {
      const p = getPlugin()
      if (token === null || token === undefined) {
        await p.clearToken({ key })
      } else {
        await p.setToken({ token: String(token), key })
      }
    },
    async clearToken(key = DEFAULT_TOKEN_KEY) {
      const p = getPlugin()
      await p.clearToken({ key })
    }
  }
}

let activeBackend = null
const defaultMemoryBackend = createMemoryStorageBackend()

export function setStorageBackend(backend) {
  activeBackend = backend
}

export function getStorageBackend() {
  if (activeBackend) return activeBackend
  try {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      return createNativeStorageBackend()
    }
  } catch {
    // fallback if Capacitor throws
  }
  return defaultMemoryBackend
}

export async function getToken(key = DEFAULT_TOKEN_KEY) {
  return getStorageBackend().getToken(key)
}

export async function setToken(token, key = DEFAULT_TOKEN_KEY) {
  return getStorageBackend().setToken(token, key)
}

export async function clearToken(key = DEFAULT_TOKEN_KEY) {
  return getStorageBackend().clearToken(key)
}
