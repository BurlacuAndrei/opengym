import { getServerUrl } from './server-config.js'
import { getToken } from './token-storage.js'

export function resolveUrl(path, serverUrl = '') {
  if (!serverUrl || /^https?:\/\//i.test(path)) return path
  const base = serverUrl.replace(/\/+$/, '')
  const normPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${normPath}`
}

export function isOffline(err) {
  return Boolean(err && (err.status === 0 || err.offline === true))
}

export function isAuthError(err) {
  return Boolean(err && err.status === 401)
}

export function isConflictError(err) {
  return Boolean(err && err.status === 409)
}

export async function nativeTransport(path, opts = {}, deps = {}) {
  const getServerUrlFn = deps.getServerUrl || getServerUrl
  const getTokenFn = deps.getToken || getToken
  const fetchFn = deps.fetchFn || globalThis.fetch

  let serverUrl = ''
  try {
    serverUrl = (await getServerUrlFn?.()) || ''
  } catch {
    serverUrl = ''
  }

  let token = null
  if (serverUrl) {
    try {
      token = (await getTokenFn?.()) || null
    } catch {
      token = null
    }
  }

  const headers = { 'Content-Type': 'application/json' }
  if (serverUrl && token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  if (opts && opts.headers) {
    if (typeof Headers !== 'undefined' && opts.headers instanceof Headers) {
      opts.headers.forEach((val, key) => { headers[key] = val })
    } else if (Array.isArray(opts.headers)) {
      for (const [k, v] of opts.headers) headers[k] = v
    } else {
      Object.assign(headers, opts.headers)
    }
  }

  if (headers['authorization'] && headers['Authorization']) {
    delete headers['Authorization']
  }

  const { headers: _discard, ...restOpts } = opts || {}
  const requestOpts = { ...restOpts, headers }
  const url = resolveUrl(path, serverUrl)

  let r
  try {
    r = await fetchFn(url, requestOpts)
  } catch (networkErr) {
    const err = new Error(networkErr?.message || 'Network error')
    err.status = 0
    err.offline = true
    err.data = null
    err.state = null
    err.serverState = null
    err.cause = networkErr
    throw err
  }

  if (r.status === 0) {
    const err = new Error('Network error (status 0)')
    err.status = 0
    err.offline = true
    err.data = null
    err.state = null
    err.serverState = null
    throw err
  }

  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const err = new Error(data?.error || ('HTTP ' + r.status))
    err.status = r.status
    err.data = data
    err.state = data?.state
    err.serverState = data?.state || data?.serverState
    err.offline = false
    throw err
  }

  return data
}

export function createNativeTransport(deps = {}) {
  return (path, opts) => nativeTransport(path, opts, deps)
}
