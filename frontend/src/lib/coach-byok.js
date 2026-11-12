import { getByokKey, setByokKey, clearByokKey } from './token-storage.js'
import { MOBILE } from './mobile.js'
import {
  build,
  buildPrompt,
  formatRequest,
  parseResponse,
  repairRunner,
  validatePlan,
  validateReview,
  cleanPlan,
  planHash,
  resolveProviderConfig,
  DATA_CATEGORIES
} from 'shared/coach/index.js'

export { getByokKey, setByokKey, clearByokKey }

let byokJob = null
let byokPending = null
const statusListeners = new Set()

export function notifyByokStatus() {
  const status = getByokStatus()
  for (const listener of statusListeners) {
    try {
      listener(status)
    } catch {}
  }
}

export function subscribeByokStatus(listener) {
  if (typeof listener === 'function') {
    statusListeners.add(listener)
  }
  return () => {
    statusListeners.delete(listener)
  }
}

export function isServerCoachActive(config, user) {
  return Boolean(config?.coach?.enabled && user)
}

export function isByokActive({ config, user, mobile = MOBILE, byokKey } = {}) {
  if (isServerCoachActive(config, user)) return false
  return Boolean(mobile && byokKey && (typeof byokKey !== 'string' || byokKey.trim()))
}

export function getCoachMode({ config, user, mobile = MOBILE, byokKey } = {}) {
  if (isServerCoachActive(config, user)) return 'server'
  if (mobile && byokKey && (typeof byokKey !== 'string' || byokKey.trim())) return 'byok'
  return 'none'
}

export async function resolveCoachMode({ config, user, mobile = MOBILE, byokKey } = {}) {
  if (isServerCoachActive(config, user)) {
    return { mode: 'server', active: true, key: null }
  }
  if (!mobile) {
    return { mode: 'none', active: false, key: null }
  }
  const rawKey = byokKey !== undefined ? byokKey : await getByokKey()
  const key = typeof rawKey === 'string' ? rawKey.trim() : rawKey
  if (key) {
    return { mode: 'byok', active: true, key }
  }
  return { mode: 'none', active: false, key: null }
}

export function getByokStatus() {
  return { job: byokJob, pending: byokPending, cap: { used: 0, limit: 0 } }
}

export async function byokDisclosure(opts = {}) {
  let key = opts.apiKey
  if (!key) {
    try { key = await getByokKey() } catch {}
  }
  const provider = (typeof key === 'string' && key.startsWith('sk-ant-')) ? 'anthropic' : (opts.provider || 'openai')
  const providerLabel = provider === 'anthropic' ? 'Anthropic Claude' : 'OpenAI'
  return {
    provider,
    providerLabel,
    categories: DATA_CATEGORIES,
    version: 1
  }
}

export function setByokPending(pending) {
  byokPending = pending
  notifyByokStatus()
}

export function clearByokPending() {
  byokPending = null
  notifyByokStatus()
}

export function resolveByokPending() {
  byokPending = null
  notifyByokStatus()
  return { ok: true }
}

export function setByokJob(job) {
  byokJob = job
  notifyByokStatus()
}

export function clearByokJob() {
  byokJob = null
  notifyByokStatus()
}

export function resetByokState() {
  byokJob = null
  byokPending = null
  notifyByokStatus()
}

export async function executeByokCoach({
  kind = 'review',
  S = {},
  uid = 'mobile-user',
  note = '',
  intake = null,
  refine = '',
  iteration: iterationParam,
  apiKey,
  providerConfig = {},
  fetchFn = globalThis.fetch,
  timeoutMs = 30000,
  maxRetries = 1
} = {}) {
  let key = apiKey
  if (!key) {
    key = await getByokKey()
  }
  if (!key || typeof key !== 'string' || !key.trim()) {
    return { ok: false, error: 'Missing BYOK API key', attempts: 0 }
  }
  key = key.trim()

  const defaultProvider = key.startsWith('sk-ant-') ? 'anthropic' : 'openai'
  const conf = resolveProviderConfig({
    provider: defaultProvider,
    ...providerConfig,
    apiKey: key
  })
  if (!conf.ok) {
    return { ok: false, error: conf.error || 'Invalid provider configuration', attempts: 0 }
  }

  const payload = build(S, uid, { kind, note, intake, refine })
  const prompt = buildPrompt(kind, payload)

  const caller = async (callArg) => {
    const promptText = typeof callArg === 'string' ? callArg : (callArg?.prompt || String(callArg))
    const req = formatRequest({
      protocol: conf.protocol,
      endpoint: conf.endpoint,
      apiKey: key,
      model: conf.model,
      prompt: promptText,
      systemPrompt: conf.systemPrompt
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)

    let res
    try {
      res = await fetchFn(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        signal: controller.signal
      })
    } catch (err) {
      if (controller.signal?.aborted || err.name === 'AbortError' || err.message?.includes('timed out')) {
        throw new Error(`Request timed out after ${timeoutMs}ms`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }

    const raw = await res.text()
    const parsed = parseResponse({
      protocol: conf.protocol,
      status: res.status,
      data: raw
    })

    if (!parsed.ok) {
      return { ok: false, status: res.status, error: parsed.error || `HTTP ${res.status}` }
    }

    return { ok: true, text: parsed.text }
  }

  const schemaValidator = (value) => {
    if (kind === 'review') {
      return validateReview(value, cleanPlan(S))
    }
    return validatePlan(value)
  }

  const runnerRes = await repairRunner({
    caller,
    schemaValidator,
    prompt,
    maxRetries
  })

  if (!runnerRes.ok) {
    return {
      ok: false,
      error: runnerRes.error || runnerRes.errors?.[0] || 'Coach execution failed',
      errors: runnerRes.errors,
      attempts: runnerRes.attempts
    }
  }

  let pending = null
  if (kind === 'review') {
    if (runnerRes.data?.nochange) {
      pending = {
        id: `byok-review-${Date.now()}`,
        kind: 'review',
        nochange: true,
        createdAt: Date.now(),
        expiresAt: Date.now() + 864e5,
        planHash: planHash(S),
        iteration: 1,
        summary: runnerRes.data.reading || '',
        changes: [],
        notes: []
      }
    } else {
      const p = runnerRes.data?.proposal || runnerRes.data
      pending = {
        id: `byok-review-${Date.now()}`,
        kind: 'review',
        createdAt: Date.now(),
        expiresAt: Date.now() + 864e5,
        planHash: planHash(S),
        iteration: 1,
        summary: p.summary || '',
        evidence: p.evidence || null,
        changes: p.changes || [],
        notes: p.notes || []
      }
    }
  } else {
    const bundle = runnerRes.data?.bundle || runnerRes.data
    const prevIteration = byokPending?.iteration || 1
    const iteration = iterationParam ?? (refine ? prevIteration + 1 : 1)
    pending = {
      id: `byok-plan-${Date.now()}`,
      kind: 'create',
      createdAt: Date.now(),
      expiresAt: Date.now() + 864e5,
      planHash: planHash(S),
      iteration,
      summary: bundle.summary || '',
      bundle
    }
  }

  return {
    ok: true,
    pending,
    attempts: runnerRes.attempts,
    repaired: runnerRes.repaired
  }
}

export async function runByokReview(opts = {}) {
  const S = opts.S || opts
  const note = opts.note || ''
  byokJob = { id: `byok-job-${Date.now()}`, kind: 'review', state: 'running', startedAt: Date.now() }
  notifyByokStatus()
  try {
    const res = await executeByokCoach({ ...opts, kind: 'review', S, note })
    if (!res.ok) {
      throw new Error(res.error || 'Failed to review training')
    }
    byokPending = res.pending
    notifyByokStatus()
    return res
  } finally {
    byokJob = null
    notifyByokStatus()
  }
}

export async function runByokPlan(opts = {}) {
  const S = opts.S || opts
  const intake = opts.intake
  const refine = opts.refine
  byokJob = { id: `byok-job-${Date.now()}`, kind: 'create', state: 'running', startedAt: Date.now() }
  notifyByokStatus()
  try {
    const res = await executeByokCoach({ ...opts, kind: 'create', S, intake, refine })
    if (!res.ok) {
      throw new Error(res.error || 'Failed to build plan')
    }
    byokPending = res.pending
    notifyByokStatus()
    return res
  } finally {
    byokJob = null
    notifyByokStatus()
  }
}
