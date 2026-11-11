/* Unified HTTPS-only Anthropic and OpenAI-compatible HTTP adapter for openGym Coach.
 *
 * Implements the standard Coach provider adapter interface:
 *   check(cfg, env)                                  → { ok, version?, error? }
 *   invoke({ prompt, jobDir, env, model, timeoutMs, cfg, ... }) → { code, text, stderr, timedOut, spawnError }
 *
 * Strictly enforces HTTPS for remote endpoints, allowing plaintext HTTP only
 * for loopback hosts (localhost, 127.0.0.1) for local inference runtimes (Ollama/vLLM).
 */

import {
  PROTOCOLS,
  PROVIDER_PRESETS,
  getProviderPreset,
  validateEndpoint,
  formatRequest,
  parseResponse,
  resolveProviderConfig
} from '../../../shared/coach/providers.js';

const SYSTEM_PROMPT = [
  'You are the openGym Coach.',
  'Answer only the supplied task and return exactly the requested JSON.',
  'You have no tools, filesystem access, external services, or persistent memory.'
].join(' ');

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Resolves API key from config, env, or options.
 */
function resolveApiKey(cfg = {}, env = {}, options = {}) {
  if (options.apiKey) return options.apiKey;
  if (cfg.apiKey) return cfg.apiKey;
  if (typeof cfg.auth === 'string') return cfg.auth;
  if (cfg.auth?.token) return cfg.auth.token;
  if (cfg.auth?.apiKey) return cfg.auth.apiKey;
  if (env.COACH_API_KEY) return env.COACH_API_KEY;
  if (env.API_KEY) return env.API_KEY;

  const protocol = options.protocol || cfg.protocol;
  const isAnthropic = protocol === PROTOCOLS.ANTHROPIC || cfg.provider === 'anthropic';
  if (isAnthropic && env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
  if (env.GROQ_API_KEY) return env.GROQ_API_KEY;
  if (env.MISTRAL_API_KEY) return env.MISTRAL_API_KEY;
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  return null;
}

/**
 * Direct unified HTTP invoker for LLM requests.
 */
export async function invokeHttp({
  endpoint,
  protocol,
  apiKey,
  model,
  prompt,
  systemPrompt = SYSTEM_PROMPT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTokens,
  temperature,
  fetchFn = globalThis.fetch,
  customHeaders
}) {
  const endpointCheck = validateEndpoint(endpoint);
  if (!endpointCheck.ok) {
    return {
      code: 1,
      text: '',
      stderr: endpointCheck.error,
      timedOut: false,
      spawnError: false
    };
  }

  let req;
  try {
    req = formatRequest({
      protocol,
      endpoint: endpointCheck.url,
      apiKey,
      model,
      prompt,
      systemPrompt,
      maxTokens,
      temperature,
      customHeaders
    });
  } catch (err) {
    return {
      code: 1,
      text: '',
      stderr: err.message || String(err),
      timedOut: false,
      spawnError: false
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetchFn(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller.signal
    });

    const bodyText = await res.text();
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = bodyText;
    }

    const parsed = parseResponse({
      protocol,
      status: res.status,
      data
    });

    if (!parsed.ok) {
      return {
        code: 1,
        text: '',
        stderr: parsed.error || `HTTP ${res.status}`,
        timedOut: false,
        spawnError: false
      };
    }

    return {
      code: 0,
      text: (parsed.text || '').trim(),
      stderr: '',
      timedOut: false,
      spawnError: false
    };
  } catch (err) {
    if (timedOut || err.name === 'AbortError') {
      return {
        code: -1,
        text: '',
        stderr: `HTTP request timed out after ${timeoutMs}ms`,
        timedOut: true,
        spawnError: false
      };
    }
    return {
      code: -1,
      text: '',
      stderr: err.message || String(err),
      timedOut: false,
      spawnError: true
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates a Coach provider adapter instance conforming to:
 *   check(cfg, env)
 *   invoke({ prompt, jobDir, env, model, timeoutMs, cfg, ... })
 */
export function createHttpAdapter(defaultOpts = {}) {
  const preset = getProviderPreset(defaultOpts.provider);
  const protocol = defaultOpts.protocol || preset?.protocol || PROTOCOLS.OPENAI;
  const id = defaultOpts.id || defaultOpts.provider || preset?.id || 'http';

  return {
    id,
    runtime: `HTTP (${protocol})`,

    async check(cfg = {}, env = {}) {
      const merged = { ...defaultOpts, ...cfg };
      const resolved = resolveProviderConfig(merged);
      if (!resolved.ok) return { ok: false, error: resolved.error };

      const apiKey = resolveApiKey(merged, env, defaultOpts);
      if (resolved.requiresApiKey && !apiKey) {
        return { ok: false, error: `API key is required for ${resolved.provider}` };
      }

      return { ok: true, version: `HTTP/${resolved.protocol}` };
    },

    async invoke({ prompt, jobDir, env = {}, model, timeoutMs = DEFAULT_TIMEOUT_MS, cfg = {}, ...rest }) {
      const mergedCfg = { ...defaultOpts, ...cfg, ...rest };
      const resolved = resolveProviderConfig(mergedCfg);
      if (!resolved.ok) {
        return { code: 1, text: '', stderr: resolved.error, timedOut: false, spawnError: false };
      }

      const apiKey = resolveApiKey(mergedCfg, env, rest);
      if (resolved.requiresApiKey && !apiKey) {
        return { code: 1, text: '', stderr: `API key is required for ${resolved.provider}`, timedOut: false, spawnError: false };
      }

      const activeModel = model || mergedCfg.model || resolved.model;
      const effectiveTimeout = timeoutMs || DEFAULT_TIMEOUT_MS;

      return invokeHttp({
        endpoint: resolved.endpoint,
        protocol: resolved.protocol,
        apiKey,
        model: activeModel,
        prompt,
        timeoutMs: effectiveTimeout,
        fetchFn: rest.fetchFn || globalThis.fetch
      });
    }
  };
}

export const anthropicAdapter = createHttpAdapter({ provider: 'anthropic' });
export const openAiAdapter = createHttpAdapter({ provider: 'openai' });
export const httpAdapter = createHttpAdapter();
export default httpAdapter;
