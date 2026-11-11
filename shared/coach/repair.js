/* Shared 1-retry validation repair runner and test connection validator.
 *
 * Implements:
 * - repairRunner({ caller, schemaValidator, prompt, systemPrompt, maxRetries = 1 })
 *   On schema/JSON failure, formats structured errors and prompts model once to fix JSON.
 * - testConnection({ provider, apiKey, model, baseUrl, ... })
 *   Pings model with minimal ping prompt and verifies valid response structure.
 */

import { REPAIR_PROMPT } from './prompts.js';
import { extractJSON } from './validate.js';
import {
  PROTOCOLS,
  PROVIDER_PRESETS,
  getProviderPreset,
  validateEndpoint,
  formatRequest,
  parseResponse
} from './providers.js';

/**
 * Resolves full endpoint URL from a base URL and protocol.
 */
export function resolveEndpointFromBaseUrl(baseUrl, protocol = PROTOCOLS.OPENAI) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (!clean) return null;
  if (clean.endsWith('/chat/completions') || clean.endsWith('/messages')) {
    return clean;
  }
  const p = (protocol || '').toLowerCase();
  if (p === PROTOCOLS.ANTHROPIC) {
    return clean.endsWith('/v1') ? `${clean}/messages` : `${clean}/v1/messages`;
  }
  return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

/**
 * Formats a repair prompt appending structured error diagnostics to original prompt.
 */
export function formatRepairPrompt({ originalPrompt, previous, errors = [] }) {
  const errList = Array.isArray(errors) ? errors : [String(errors)];
  const formattedErrors = errList
    .map(e => (typeof e === 'string' ? e : (e?.message || JSON.stringify(e))))
    .filter(Boolean);
  const errText = formattedErrors.length > 0
    ? formattedErrors.map(e => `- ${e}`).join('\n')
    : '- Validation failed: schema or structure did not match expected format';

  const prevText = String(previous || '').slice(0, 4000);

  const repairBlock = REPAIR_PROMPT
    .replace('{{PREVIOUS}}', prevText)
    .replace('{{ERRORS}}', errText);

  if (originalPrompt && typeof originalPrompt === 'string' && originalPrompt.trim()) {
    return `${originalPrompt}\n\n---\n\n${repairBlock}`;
  }
  return repairBlock;
}

/**
 * Extracts response text from various caller return formats.
 */
export function extractCallerText(res) {
  if (typeof res === 'string') return res;
  if (!res || typeof res !== 'object') return '';
  if (typeof res.text === 'string') return res.text;
  if (typeof res.raw === 'string') return res.raw;
  if (typeof res.content === 'string') return res.content;
  if (Array.isArray(res.content)) {
    return res.content
      .filter(c => c && (c.type === 'text' || typeof c.text === 'string'))
      .map(c => c.text || '')
      .join('');
  }
  if (Array.isArray(res.choices) && res.choices.length > 0) {
    const choice = res.choices[0];
    return choice?.message?.content ?? choice?.text ?? '';
  }
  if (typeof res.body === 'string') return res.body;
  if (typeof res.message === 'string') return res.message;
  return '';
}

/**
 * Wraps caller arguments to support both object-destructuring callers ({ prompt, systemPrompt })
 * and callers that treat the argument directly as a prompt string.
 */
function createCallerArg(currentPrompt, systemPrompt, attempt, isRetry, lastRaw, lastErrors) {
  const repairContext = isRetry ? { previous: lastRaw, errors: lastErrors } : null;
  return {
    prompt: currentPrompt,
    systemPrompt,
    attempt,
    isRetry,
    repair: repairContext,
    toString() { return currentPrompt; },
    valueOf() { return currentPrompt; },
    [Symbol.toPrimitive]() { return currentPrompt; },
    indexOf(...args) { return currentPrompt.indexOf(...args); },
    includes(...args) { return currentPrompt.includes(...args); },
    startsWith(...args) { return currentPrompt.startsWith(...args); },
    endsWith(...args) { return currentPrompt.endsWith(...args); },
    slice(...args) { return currentPrompt.slice(...args); },
    substring(...args) { return currentPrompt.substring(...args); },
    trim(...args) { return currentPrompt.trim(...args); },
    replace(...args) { return currentPrompt.replace(...args); },
    match(...args) { return currentPrompt.match(...args); }
  };
}

/**
 * Executes a prompt with 1-retry validation repair loop (FR-48).
 *
 * On schema or JSON failure, formats structured errors and prompts model once to fix JSON.
 * Returns { ok: true, data, raw, attempts, repaired } or { ok: false, errors, raw, attempts, repaired }.
 */
export async function repairRunner({
  caller,
  schemaValidator,
  prompt,
  systemPrompt,
  maxRetries = 1
} = {}) {
  if (typeof caller !== 'function') {
    throw new TypeError('repairRunner requires a caller function');
  }

  let currentPrompt = prompt || '';
  let attempts = 0;
  let lastErrors = [];
  let lastRaw = '';

  while (attempts <= maxRetries) {
    attempts++;
    const isRetry = attempts > 1;

    let res;
    try {
      const callArg = createCallerArg(currentPrompt, systemPrompt, attempts, isRetry, lastRaw, lastErrors);
      res = await caller(callArg, systemPrompt);
    } catch (err) {
      return {
        ok: false,
        error: err.message || String(err),
        errors: [err.message || String(err)],
        attempts,
        raw: lastRaw,
        repaired: false
      };
    }

    const rawText = extractCallerText(res);
    lastRaw = rawText;

    // Handle explicit failure returned by caller (e.g. { ok: false, error })
    if (res && typeof res === 'object' && res.ok === false) {
      return {
        ok: false,
        error: res.error || res.stderr || 'Caller invocation failed',
        errors: [res.error || res.stderr || 'Caller invocation failed'],
        attempts,
        raw: rawText,
        repaired: false
      };
    }

    // Syntax validation: extract JSON
    const extracted = extractJSON(rawText);
    if (extracted.error) {
      lastErrors = [extracted.error];
      if (attempts <= maxRetries) {
        currentPrompt = formatRepairPrompt({
          originalPrompt: prompt,
          previous: rawText,
          errors: lastErrors
        });
        continue;
      }
      return {
        ok: false,
        errors: lastErrors,
        raw: rawText,
        attempts,
        repaired: false
      };
    }

    // Semantic schema validation
    let validationResult = null;
    let schemaErrors = [];

    if (typeof schemaValidator === 'function') {
      try {
        validationResult = await schemaValidator(extracted.value, rawText);
        if (validationResult === false) {
          schemaErrors = ['Schema validation failed'];
        } else if (validationResult && typeof validationResult === 'object') {
          if (validationResult.ok === false || validationResult.valid === false) {
            schemaErrors = Array.isArray(validationResult.errors) && validationResult.errors.length
              ? validationResult.errors
              : [validationResult.error || 'Schema validation failed'];
          } else if (Array.isArray(validationResult.errors) && validationResult.errors.length && validationResult.ok !== true) {
            schemaErrors = validationResult.errors;
          }
        }
      } catch (err) {
        schemaErrors = [err.message || String(err)];
      }
    }

    if (schemaErrors.length > 0) {
      lastErrors = schemaErrors;
      if (attempts <= maxRetries) {
        currentPrompt = formatRepairPrompt({
          originalPrompt: prompt,
          previous: rawText,
          errors: lastErrors
        });
        continue;
      }
      return {
        ok: false,
        errors: lastErrors,
        raw: rawText,
        attempts,
        repaired: false
      };
    }

    // Success
    const data = validationResult && typeof validationResult === 'object'
      ? (validationResult.bundle || validationResult.proposal || validationResult.data || extracted.value)
      : extracted.value;

    return {
      ok: true,
      data,
      result: data,
      value: extracted.value,
      raw: rawText,
      attempts,
      repaired: isRetry
    };
  }

  return {
    ok: false,
    errors: lastErrors.length > 0 ? lastErrors : ['Maximum retries exceeded'],
    raw: lastRaw,
    attempts,
    repaired: false
  };
}

/**
 * Pings provider model with minimal ping prompt and verifies valid response structure.
 * Returns { ok: true, provider, model, text, latencyMs, usage } or { ok: false, error, status? }.
 */
export async function testConnection({
  provider,
  apiKey,
  model,
  baseUrl,
  endpoint,
  protocol,
  pingPrompt = 'ping',
  timeoutMs = 15000,
  fetchFn = globalThis.fetch,
  customHeaders
} = {}) {
  const preset = getProviderPreset(provider);
  const effectiveProtocol = protocol || preset?.protocol || PROTOCOLS.OPENAI;

  let targetEndpoint = endpoint;
  if (!targetEndpoint && baseUrl) {
    targetEndpoint = resolveEndpointFromBaseUrl(baseUrl, effectiveProtocol);
  }
  if (!targetEndpoint && preset?.endpoint) {
    targetEndpoint = preset.endpoint;
  }
  if (!targetEndpoint) {
    targetEndpoint = effectiveProtocol === PROTOCOLS.ANTHROPIC
      ? PROVIDER_PRESETS.anthropic.endpoint
      : PROVIDER_PRESETS.openai.endpoint;
  }

  const endpointCheck = validateEndpoint(targetEndpoint);
  if (!endpointCheck.ok) {
    return { ok: false, error: endpointCheck.error };
  }

  if (preset?.requiresApiKey && !apiKey) {
    return { ok: false, error: `API key is required for ${preset.label || provider}` };
  }

  const effectiveModel = model || preset?.defaultModel || (effectiveProtocol === PROTOCOLS.ANTHROPIC ? 'claude-3-7-sonnet-latest' : 'gpt-4o');

  let req;
  try {
    req = formatRequest({
      protocol: effectiveProtocol,
      endpoint: endpointCheck.url,
      apiKey,
      model: effectiveModel,
      prompt: pingPrompt,
      maxTokens: 50,
      customHeaders
    });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  if (typeof fetchFn !== 'function') {
    return { ok: false, error: 'fetch function is not available' };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  let timedOut = false;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const startTime = Date.now();
  try {
    const res = await fetchFn(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller?.signal
    });

    const bodyText = await res.text();
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = bodyText;
    }

    const parsed = parseResponse({
      protocol: effectiveProtocol,
      status: res.status,
      data
    });

    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.error || `HTTP ${res.status}`,
        status: res.status
      };
    }

    return {
      ok: true,
      provider: provider || preset?.id || 'custom',
      model: effectiveModel,
      text: (parsed.text || '').trim(),
      latencyMs: Date.now() - startTime,
      usage: parsed.usage
    };
  } catch (err) {
    if (timedOut || err.name === 'AbortError') {
      return { ok: false, error: `Connection timed out after ${timeoutMs}ms` };
    }
    return { ok: false, error: err.message || String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
