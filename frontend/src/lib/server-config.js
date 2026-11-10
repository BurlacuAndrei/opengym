import { t } from './i18n.js'
import { MOBILE } from './mobile.js'
import { IS_ANDROID } from './api.js'

export const SERVER_CONFIG_KEY = 'gym_server_config'

export function isServerSupported({ mobile = MOBILE, isAndroid = IS_ANDROID } = {}) {
  return Boolean(mobile && isAndroid)
}

export function getServerConfig() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SERVER_CONFIG_KEY) : null
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function getServerUrl() {
  return getServerConfig()?.url || ''
}

export function saveServerConfig(config) {
  if (!config) {
    clearServerConfig()
    return
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify(config))
  }
}

export function clearServerConfig() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(SERVER_CONFIG_KEY)
  }
}

export function normalizeServerUrl(rawUrl) {
  const trimmed = (rawUrl || '').trim()
  if (!trimmed) {
    return { ok: true, removed: true, url: '' }
  }

  if (!/^https:\/\//i.test(trimmed)) {
    return { ok: false, error: t('Server URL must use HTTPS') }
  }

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: t('Invalid or unreachable openGym server') }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: t('Server URL must use HTTPS') }
  }

  const pathname = parsed.pathname
    .replace(/\/api\/config\/?$/, '')
    .replace(/\/+$/, '')

  const cleanUrl = parsed.origin + (pathname === '/' ? '' : pathname)
  return { ok: true, url: cleanUrl }
}

export async function verifyServer(rawUrl, { fetchFn = globalThis.fetch, save = true } = {}) {
  const norm = normalizeServerUrl(rawUrl)
  if (!norm.ok) return norm

  if (norm.removed) {
    if (save) clearServerConfig()
    return { ok: true, removed: true, config: null }
  }

  let res
  try {
    res = await (fetchFn || globalThis.fetch)(`${norm.url}/api/config`, {
      headers: { 'Accept': 'application/json' },
    })
  } catch {
    return { ok: false, error: t('Invalid or unreachable openGym server') }
  }

  if (!res || !res.ok) {
    return { ok: false, error: t('Invalid or unreachable openGym server') }
  }

  let data
  try {
    data = await res.json()
  } catch {
    return { ok: false, error: t('Invalid or unreachable openGym server') }
  }

  if (!data || typeof data !== 'object') {
    return { ok: false, error: t('Invalid or unreachable openGym server') }
  }

  if (!data.native) {
    return { ok: false, error: t('Server needs updating') }
  }

  const config = {
    url: norm.url,
    native: data.native,
    rpId: data.native?.rpId || '',
  }

  if (save) {
    saveServerConfig(config)
  }

  return { ok: true, config }
}
