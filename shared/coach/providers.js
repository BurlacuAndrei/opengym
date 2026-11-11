/* Provider preset registry and HTTP protocol formatters for OpenGym Coach.
 *
 * Supports Anthropic (Claude) messages protocol and OpenAI-compatible chat completions
 * protocol across Anthropic, OpenAI, Groq, OpenRouter, Mistral, and local Ollama/vLLM.
 *
 * Enforces HTTPS-only communication with external APIs; plaintext HTTP is strictly
 * restricted to loopback (localhost / 127.0.0.1) for local self-hosted runtimes.
 */

export const PROTOCOLS = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai'
});

export const PROVIDER_PRESETS = Object.freeze({
  anthropic: Object.freeze({
    id: 'anthropic',
    label: 'Anthropic',
    protocol: PROTOCOLS.ANTHROPIC,
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-3-7-sonnet-latest',
    models: Object.freeze([
      'claude-3-7-sonnet-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-3-opus-latest'
    ]),
    requiresApiKey: true,
    local: false
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    protocol: PROTOCOLS.OPENAI,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    models: Object.freeze([
      'gpt-4o',
      'gpt-4o-mini',
      'o3-mini',
      'o1',
      'o1-mini'
    ]),
    requiresApiKey: true,
    local: false
  }),
  groq: Object.freeze({
    id: 'groq',
    label: 'Groq',
    protocol: PROTOCOLS.OPENAI,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    models: Object.freeze([
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768'
    ]),
    requiresApiKey: true,
    local: false
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: PROTOCOLS.OPENAI,
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    models: Object.freeze([
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
      'meta-llama/llama-3.3-70b-instruct'
    ]),
    requiresApiKey: true,
    local: false
  }),
  mistral: Object.freeze({
    id: 'mistral',
    label: 'Mistral',
    protocol: PROTOCOLS.OPENAI,
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: 'mistral-large-latest',
    models: Object.freeze([
      'mistral-large-latest',
      'mistral-small-latest',
      'codestral-latest'
    ]),
    requiresApiKey: true,
    local: false
  }),
  ollama: Object.freeze({
    id: 'ollama',
    label: 'Ollama (Local)',
    protocol: PROTOCOLS.OPENAI,
    endpoint: 'http://localhost:11434/v1/chat/completions',
    defaultModel: 'llama3.2',
    models: Object.freeze([
      'llama3.2',
      'mistral',
      'qwen2.5'
    ]),
    requiresApiKey: false,
    local: true
  })
});

export const PROVIDER_ALIASES = Object.freeze({
  local: 'ollama',
  vllm: 'ollama',
  claude: 'anthropic'
});

/**
 * Look up a provider preset by ID, name, or alias (case-insensitive).
 */
export function getProviderPreset(idOrName) {
  if (!idOrName || typeof idOrName !== 'string') return null;
  const key = idOrName.trim().toLowerCase();
  if (PROVIDER_PRESETS[key]) return PROVIDER_PRESETS[key];
  const alias = PROVIDER_ALIASES[key];
  if (alias && PROVIDER_PRESETS[alias]) {
    return PROVIDER_PRESETS[alias];
  }
  return null;
}

/**
 * Checks whether an endpoint URL is allowed.
 * HTTPS is strictly required for remote hosts.
 * Plaintext HTTP is allowed ONLY for loopback/localhost (e.g. Ollama, vLLM).
 */
export function isAllowedEndpoint(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const url = new URL(urlStr);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') {
      const h = url.hostname.toLowerCase();
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Validates endpoint URL and returns { ok, url } or { ok: false, error }.
 */
export function validateEndpoint(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { ok: false, error: 'Endpoint URL is required' };
  }
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return { ok: false, error: 'Invalid endpoint URL format' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Endpoint must use https:// (or http:// for localhost/127.0.0.1)' };
  }

  if (url.protocol === 'http:') {
    const h = url.hostname.toLowerCase();
    const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
    if (!isLocal) {
      return { ok: false, error: 'Plaintext http:// is only allowed for localhost or 127.0.0.1' };
    }
  }

  return { ok: true, url: url.toString() };
}

/**
 * Formats a request for the target protocol ('anthropic' | 'openai').
 * Returns { url, headers, body }.
 */
export function formatRequest({
  protocol,
  endpoint,
  apiKey,
  model,
  prompt,
  systemPrompt,
  maxTokens,
  temperature,
  customHeaders = {}
}) {
  const endpointCheck = validateEndpoint(endpoint);
  if (!endpointCheck.ok) {
    throw new Error(endpointCheck.error);
  }

  const p = (protocol || '').toLowerCase();
  if (p === PROTOCOLS.ANTHROPIC) {
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...customHeaders
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
    const body = {
      model,
      max_tokens: maxTokens || 4096,
      messages: [{ role: 'user', content: prompt }]
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (typeof temperature === 'number') {
      body.temperature = temperature;
    }
    return {
      url: endpointCheck.url,
      headers,
      body: JSON.stringify(body)
    };
  }

  if (p === PROTOCOLS.OPENAI) {
    const headers = {
      'content-type': 'application/json',
      ...customHeaders
    };
    if (apiKey) {
      headers['authorization'] = `Bearer ${apiKey}`;
    }
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body = {
      model,
      messages
    };
    if (typeof maxTokens === 'number') {
      body.max_tokens = maxTokens;
    }
    if (typeof temperature === 'number') {
      body.temperature = temperature;
    }
    return {
      url: endpointCheck.url,
      headers,
      body: JSON.stringify(body)
    };
  }

  throw new Error(`Unsupported protocol: ${protocol}. Expected 'anthropic' or 'openai'.`);
}

/**
 * Parses HTTP responses from Anthropic or OpenAI-compatible endpoints.
 * Returns { ok: true, text, usage? } or { ok: false, error, status? }.
 */
export function parseResponse({ protocol, status, data }) {
  const p = (protocol || '').toLowerCase();
  let obj = data;
  if (typeof data === 'string') {
    try {
      obj = JSON.parse(data);
    } catch {
      obj = null;
    }
  }

  // Handle HTTP error statuses
  if (typeof status === 'number' && (status < 200 || status >= 300)) {
    let errMessage = `HTTP ${status}`;
    if (obj && typeof obj === 'object') {
      if (typeof obj.error === 'string') {
        errMessage = obj.error;
      } else if (obj.error?.message) {
        errMessage = obj.error.message;
      } else if (obj.message) {
        errMessage = obj.message;
      }
    } else if (typeof data === 'string' && data.trim()) {
      errMessage = data.slice(0, 300);
    }
    return { ok: false, status, error: errMessage };
  }

  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'Empty or non-JSON response from provider' };
  }

  if (p === PROTOCOLS.ANTHROPIC) {
    if (Array.isArray(obj.content)) {
      const text = obj.content
        .filter(c => c && c.type === 'text')
        .map(c => c.text || '')
        .join('');
      return { ok: true, text, usage: obj.usage };
    }
    if (typeof obj.completion === 'string') {
      return { ok: true, text: obj.completion, usage: obj.usage };
    }
    return { ok: false, error: 'Unexpected Anthropic response structure: missing content' };
  }

  if (p === PROTOCOLS.OPENAI) {
    if (Array.isArray(obj.choices) && obj.choices.length > 0) {
      const choice = obj.choices[0];
      const text = choice.message?.content ?? choice.text ?? '';
      return { ok: true, text, usage: obj.usage };
    }
    return { ok: false, error: 'Unexpected OpenAI response structure: missing choices' };
  }

  return { ok: false, error: `Unsupported protocol: ${protocol}` };
}

/**
 * Resolves full provider configuration combining presets and explicit options.
 */
export function resolveProviderConfig(opts = {}) {
  const preset = getProviderPreset(opts.provider);
  const protocol = opts.protocol || preset?.protocol || PROTOCOLS.OPENAI;
  const endpoint = opts.endpoint || preset?.endpoint || (protocol === PROTOCOLS.ANTHROPIC ? PROVIDER_PRESETS.anthropic.endpoint : PROVIDER_PRESETS.openai.endpoint);
  const model = opts.model || preset?.defaultModel || (protocol === PROTOCOLS.ANTHROPIC ? 'claude-3-7-sonnet-latest' : 'gpt-4o');
  const requiresApiKey = preset ? preset.requiresApiKey : (opts.requiresApiKey !== undefined ? opts.requiresApiKey : true);

  const endpointCheck = validateEndpoint(endpoint);
  if (!endpointCheck.ok) {
    return { ok: false, error: endpointCheck.error };
  }

  return {
    ok: true,
    provider: opts.provider || preset?.id || 'custom',
    protocol,
    endpoint: endpointCheck.url,
    model,
    preset: preset || null,
    requiresApiKey
  };
}
