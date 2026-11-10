import { Capacitor, registerPlugin } from '@capacitor/core'
import { nativeTransport } from './native-transport.js'
import { MOBILE } from './mobile.js'
import { getServerUrl } from './server-config.js'
import { setToken } from './token-storage.js'

let _nativePasskey = null
export const setNativePasskey = p => { _nativePasskey = p }
export const getNativePasskey = () => {
  if (_nativePasskey) return _nativePasskey
  if (typeof Capacitor !== 'undefined' && Capacitor?.Plugins?.NativePasskey) {
    _nativePasskey = Capacitor.Plugins.NativePasskey
    return _nativePasskey
  }
  try {
    _nativePasskey = registerPlugin('NativePasskey')
  } catch {
    _nativePasskey = Capacitor?.Plugins?.NativePasskey || {}
  }
  return _nativePasskey
}
const nativePasskeyOverrides = {}
export const NativePasskey = new Proxy(nativePasskeyOverrides, {
  get(target, prop) {
    if (prop in target) return target[prop]
    const p = getNativePasskey()
    const val = p ? p[prop] : undefined
    return typeof val === 'function' ? val.bind(p) : val
  },
  set(target, prop, value) {
    target[prop] = value
    return true
  }
})

// Backend + WebAuthn helpers (ported from the vanilla app).
export const isAndroid = () => /Android/.test(typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '')
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '')
export const IS_ANDROID = /Android/.test(typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '')
export const BIO = IS_APPLE ? 'Face ID / Touch ID' : IS_ANDROID ? 'fingerprint or face unlock' : 'your fingerprint, face or PIN'
export const VAULT = IS_APPLE ? 'iCloud Keychain' : IS_ANDROID ? 'Google Password Manager' : 'your password manager'
export const isServerModeAndroid = () => Boolean(
  MOBILE &&
  (IS_ANDROID || isAndroid() || (typeof Capacitor !== 'undefined' && Capacitor.getPlatform?.() === 'android')) &&
  getServerUrl()
)
export const webauthnOK = () => {
  if (MOBILE && (IS_ANDROID || isAndroid() || (typeof Capacitor !== 'undefined' && Capacitor.getPlatform?.() === 'android'))) return true
  return !!(typeof window !== 'undefined' && window.PublicKeyCredential && navigator.credentials)
}

export { nativeTransport, isOffline, isAuthError, isConflictError } from './native-transport.js'

let transport = null
export const setTransport = fn => { transport = fn }
export const resetTransport = () => { transport = null }

export async function api(path, opts) {
  if (transport) return transport(path, opts)
  return nativeTransport(path, opts)
}

const bufToB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uToBuf = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer

function toCreationOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  o.user.id = b64uToBuf(o.user.id)
  ;(o.excludeCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function toRequestOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  ;(o.allowCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function credToJSON(cred) {
  const r = cred.response
  const out = {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    authenticatorAttachment: cred.authenticatorAttachment || null,
    response: { clientDataJSON: bufToB64u(r.clientDataJSON) }
  }
  if (r.attestationObject) {
    out.response.attestationObject = bufToB64u(r.attestationObject)
    out.response.transports = r.getTransports ? r.getTransports() : ['internal']
  }
  if (r.authenticatorData) {
    out.response.authenticatorData = bufToB64u(r.authenticatorData)
    out.response.signature = bufToB64u(r.signature)
    out.response.userHandle = r.userHandle ? bufToB64u(r.userHandle) : null
  }
  return out
}
export async function passkeyRegister(name, codeOrOpts = '', maybeOpts = {}) {
  const code = typeof codeOrOpts === 'string' ? codeOrOpts : ''
  const opts = typeof codeOrOpts === 'object' && codeOrOpts !== null ? codeOrOpts : maybeOpts
  const { cid, options } = await api('/api/register/options', { method: 'POST', body: JSON.stringify({ name, code: code || '' }) })
  const isAndroidServer = opts.isAndroidServer ?? isServerModeAndroid()
  let cred
  if (isAndroidServer) {
    const plugin = opts.nativePasskey || NativePasskey
    let passkeyRes
    try {
      passkeyRes = await plugin.register({ options })
    } catch (err) {
      if (err?.message === 'USER_CANCELLED' || err?.code === 'USER_CANCELLED' || String(err?.message || err).includes('USER_CANCELLED')) {
        const cancelErr = new Error('USER_CANCELLED')
        cancelErr.name = 'AbortError'
        cancelErr.code = 'USER_CANCELLED'
        throw cancelErr
      }
      throw err
    }
    cred = passkeyRes?.credential || passkeyRes
  } else {
    cred = credToJSON(await navigator.credentials.create({ publicKey: toCreationOptions(options) }))
  }
  const body = isAndroidServer ? { cid, credential: cred, native: true } : { cid, credential: cred }
  const res = await api('/api/register/verify', { method: 'POST', body: JSON.stringify(body) })
  if (res.token) {
    await (opts.setToken || setToken)(res.token)
  }
  if (res.user) {
    try {
      const { useStore } = await import('../store/useStore.js')
      useStore.getState().setUser(res.user)
    } catch {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('gym_user', JSON.stringify(res.user))
        localStorage.removeItem('gym_guest')
      }
    }
  }
  return res.user
}
export async function passkeyLogin(opts = {}) {
  const { cid, options } = await api('/api/login/options', { method: 'POST', body: '{}' })
  const isAndroidServer = opts.isAndroidServer ?? isServerModeAndroid()
  let cred
  if (isAndroidServer) {
    const plugin = opts.nativePasskey || NativePasskey
    let passkeyRes
    try {
      passkeyRes = await plugin.login({ options })
    } catch (err) {
      if (err?.message === 'USER_CANCELLED' || err?.code === 'USER_CANCELLED' || String(err?.message || err).includes('USER_CANCELLED')) {
        const cancelErr = new Error('USER_CANCELLED')
        cancelErr.name = 'AbortError'
        cancelErr.code = 'USER_CANCELLED'
        throw cancelErr
      }
      throw err
    }
    cred = passkeyRes?.credential || passkeyRes
  } else {
    cred = credToJSON(await navigator.credentials.get({ publicKey: toRequestOptions(options) }))
  }
  const body = isAndroidServer ? { cid, credential: cred, native: true } : { cid, credential: cred }
  const res = await api('/api/login/verify', { method: 'POST', body: JSON.stringify(body) })
  if (res.token) {
    await (opts.setToken || setToken)(res.token)
  }
  if (res.user) {
    try {
      const { useStore } = await import('../store/useStore.js')
      useStore.getState().setUser(res.user)
    } catch {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('gym_user', JSON.stringify(res.user))
        localStorage.removeItem('gym_guest')
      }
    }
  }
  return res.user
}
