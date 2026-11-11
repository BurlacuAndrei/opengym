import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOLS,
  PROVIDER_PRESETS,
  PROVIDER_ALIASES,
  getProviderPreset,
  isAllowedEndpoint,
  validateEndpoint,
  formatRequest,
  parseResponse,
  resolveProviderConfig
} from './providers.js';

import {
  invokeHttp,
  createHttpAdapter,
  anthropicAdapter,
  openAiAdapter,
  httpAdapter
} from '../../api/coach/adapters/http.js';
import { adapterFor } from '../../api/coach/adapters/index.js';

/* ---------------- 1. Preset Registry ---------------- */

test('provider preset registry contains all required providers', () => {
  const expected = ['anthropic', 'openai', 'groq', 'openrouter', 'mistral', 'ollama'];
  for (const id of expected) {
    assert.ok(PROVIDER_PRESETS[id], `Missing preset: ${id}`);
    const preset = PROVIDER_PRESETS[id];
    assert.equal(preset.id, id);
    assert.ok(preset.label, `Preset ${id} has no label`);
    assert.ok(preset.protocol === PROTOCOLS.ANTHROPIC || preset.protocol === PROTOCOLS.OPENAI);
    assert.ok(preset.endpoint, `Preset ${id} has no endpoint`);
    assert.ok(preset.defaultModel, `Preset ${id} has no defaultModel`);
    assert.ok(Array.isArray(preset.models) && preset.models.length > 0, `Preset ${id} has empty models`);
  }
});

test('preset protocols are correctly assigned', () => {
  assert.equal(PROVIDER_PRESETS.anthropic.protocol, 'anthropic');
  assert.equal(PROVIDER_PRESETS.openai.protocol, 'openai');
  assert.equal(PROVIDER_PRESETS.groq.protocol, 'openai');
  assert.equal(PROVIDER_PRESETS.openrouter.protocol, 'openai');
  assert.equal(PROVIDER_PRESETS.mistral.protocol, 'openai');
  assert.equal(PROVIDER_PRESETS.ollama.protocol, 'openai');
});

test('Ollama preset is local and does not require an API key', () => {
  assert.equal(PROVIDER_PRESETS.ollama.local, true);
  assert.equal(PROVIDER_PRESETS.ollama.requiresApiKey, false);
  assert.ok(PROVIDER_PRESETS.ollama.endpoint.startsWith('http://localhost'));

  assert.equal(PROVIDER_PRESETS.anthropic.requiresApiKey, true);
  assert.equal(PROVIDER_PRESETS.openai.requiresApiKey, true);
});

test('getProviderPreset matches case-insensitively and resolves aliases', () => {
  assert.equal(getProviderPreset('anthropic'), PROVIDER_PRESETS.anthropic);
  assert.equal(getProviderPreset('ANTHROPIC'), PROVIDER_PRESETS.anthropic);
  assert.equal(getProviderPreset('OpenAI'), PROVIDER_PRESETS.openai);
  assert.equal(getProviderPreset('Groq'), PROVIDER_PRESETS.groq);
  assert.equal(getProviderPreset('OpenRouter'), PROVIDER_PRESETS.openrouter);
  assert.equal(getProviderPreset('Mistral'), PROVIDER_PRESETS.mistral);
  assert.equal(getProviderPreset('Ollama'), PROVIDER_PRESETS.ollama);

  // Aliases
  assert.equal(getProviderPreset('local'), PROVIDER_PRESETS.ollama);
  assert.equal(getProviderPreset('vllm'), PROVIDER_PRESETS.ollama);
  assert.equal(getProviderPreset('claude'), PROVIDER_PRESETS.anthropic);

  // Unknown or invalid
  assert.equal(getProviderPreset('unknown-provider'), null);
  assert.equal(getProviderPreset(''), null);
  assert.equal(getProviderPreset(null), null);
});

/* ---------------- 2. HTTPS-Only Enforcement ---------------- */

test('isAllowedEndpoint permits HTTPS and loopback plaintext HTTP only', () => {
  // Remote HTTPS is allowed
  assert.equal(isAllowedEndpoint('https://api.openai.com/v1/chat/completions'), true);
  assert.equal(isAllowedEndpoint('https://api.anthropic.com/v1/messages'), true);
  assert.equal(isAllowedEndpoint('https://openrouter.ai/api/v1'), true);

  // Loopback HTTP is allowed (Ollama, local vLLM)
  assert.equal(isAllowedEndpoint('http://localhost:11434/v1/chat/completions'), true);
  assert.equal(isAllowedEndpoint('http://127.0.0.1:11434/v1/chat/completions'), true);
  assert.equal(isAllowedEndpoint('http://127.0.0.1:8000/v1'), true);
  assert.equal(isAllowedEndpoint('http://[::1]:11434/v1'), true);
  assert.equal(isAllowedEndpoint('http://test.localhost:8080/v1'), true);

  // Plaintext HTTP to remote hosts is disallowed
  assert.equal(isAllowedEndpoint('http://api.openai.com/v1/chat/completions'), false);
  assert.equal(isAllowedEndpoint('http://api.anthropic.com/v1/messages'), false);
  assert.equal(isAllowedEndpoint('http://192.168.1.100:11434/v1'), false);
  assert.equal(isAllowedEndpoint('http://10.0.0.1:8000/v1'), false);
  assert.equal(isAllowedEndpoint('http://example.com/api'), false);

  // Other schemes or invalid URLs
  assert.equal(isAllowedEndpoint('ftp://api.openai.com'), false);
  assert.equal(isAllowedEndpoint('file:///etc/passwd'), false);
  assert.equal(isAllowedEndpoint('not-a-url'), false);
  assert.equal(isAllowedEndpoint(''), false);
  assert.equal(isAllowedEndpoint(null), false);
});

test('validateEndpoint returns descriptive errors on disallowed endpoints', () => {
  assert.deepEqual(validateEndpoint('https://api.openai.com/v1'), {
    ok: true,
    url: 'https://api.openai.com/v1'
  });

  assert.deepEqual(validateEndpoint('http://localhost:11434/v1'), {
    ok: true,
    url: 'http://localhost:11434/v1'
  });

  const remoteHttp = validateEndpoint('http://api.groq.com/openai/v1');
  assert.equal(remoteHttp.ok, false);
  assert.match(remoteHttp.error, /localhost or 127\.0\.0\.1/);

  const badScheme = validateEndpoint('gopher://example.com');
  assert.equal(badScheme.ok, false);
  assert.match(badScheme.error, /must use https/);

  const invalid = validateEndpoint('invalid-url-string');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Invalid endpoint URL/);
});

/* ---------------- 3. Request Formatter ---------------- */

test('formatRequest formats Anthropic requests correctly', () => {
  const req = formatRequest({
    protocol: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKey: 'sk-ant-test-key',
    model: 'claude-3-7-sonnet-latest',
    prompt: 'Give me a workout plan',
    systemPrompt: 'You are the openGym Coach.',
    maxTokens: 2048,
    temperature: 0.2
  });

  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['x-api-key'], 'sk-ant-test-key');

  const body = JSON.parse(req.body);
  assert.equal(body.model, 'claude-3-7-sonnet-latest');
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.system, 'You are the openGym Coach.');
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Give me a workout plan' }]);
});

test('formatRequest formats OpenAI requests correctly', () => {
  const req = formatRequest({
    protocol: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: 'sk-openai-test-key',
    model: 'gpt-4o',
    prompt: 'Give me a workout plan',
    systemPrompt: 'You are the openGym Coach.'
  });

  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers['authorization'], 'Bearer sk-openai-test-key');

  const body = JSON.parse(req.body);
  assert.equal(body.model, 'gpt-4o');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are the openGym Coach.' },
    { role: 'user', content: 'Give me a workout plan' }
  ]);
});

test('formatRequest without apiKey omits auth header (for Ollama/local)', () => {
  const req = formatRequest({
    protocol: 'openai',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'llama3.2',
    prompt: 'Hello local model'
  });

  assert.equal(req.headers['authorization'], undefined);
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'llama3.2');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello local model' }]);
});

test('formatRequest rejects plaintext HTTP remote endpoint', () => {
  assert.throws(() => {
    formatRequest({
      protocol: 'openai',
      endpoint: 'http://api.openai.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      prompt: 'test'
    });
  }, /localhost or 127\.0\.0\.1/);
});

/* ---------------- 4. Response Parser ---------------- */

test('parseResponse extracts text from Anthropic response', () => {
  const anthropicRes = {
    content: [
      { type: 'text', text: '{"coach_contract":1,"ok":true}' }
    ],
    usage: { input_tokens: 10, output_tokens: 20 }
  };

  const parsed = parseResponse({
    protocol: 'anthropic',
    status: 200,
    data: anthropicRes
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, '{"coach_contract":1,"ok":true}');
  assert.equal(parsed.usage.output_tokens, 20);
});

test('parseResponse extracts text from OpenAI response', () => {
  const openAiRes = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '{"coach_contract":1,"ok":true}'
        }
      }
    ],
    usage: { prompt_tokens: 15, completion_tokens: 25 }
  };

  const parsed = parseResponse({
    protocol: 'openai',
    status: 200,
    data: openAiRes
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, '{"coach_contract":1,"ok":true}');
  assert.equal(parsed.usage.prompt_tokens, 15);
});

test('parseResponse handles non-200 HTTP error responses', () => {
  const authErr = parseResponse({
    protocol: 'openai',
    status: 401,
    data: { error: { message: 'Incorrect API key provided' } }
  });
  assert.equal(authErr.ok, false);
  assert.equal(authErr.status, 401);
  assert.equal(authErr.error, 'Incorrect API key provided');

  const rateLimitErr = parseResponse({
    protocol: 'anthropic',
    status: 429,
    data: { error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }
  });
  assert.equal(rateLimitErr.ok, false);
  assert.equal(rateLimitErr.status, 429);
  assert.equal(rateLimitErr.error, 'Rate limit exceeded');
});

test('parseResponse handles malformed or non-JSON payloads', () => {
  const emptyRes = parseResponse({
    protocol: 'openai',
    status: 200,
    data: null
  });
  assert.equal(emptyRes.ok, false);
  assert.match(emptyRes.error, /Empty or non-JSON/);

  const missingChoices = parseResponse({
    protocol: 'openai',
    status: 200,
    data: { choices: [] }
  });
  assert.equal(missingChoices.ok, false);
  assert.match(missingChoices.error, /missing choices/);
});

/* ---------------- 5. Provider Config Resolver ---------------- */

test('resolveProviderConfig correctly resolves presets and custom options', () => {
  const groq = resolveProviderConfig({ provider: 'groq' });
  assert.equal(groq.ok, true);
  assert.equal(groq.protocol, 'openai');
  assert.equal(groq.endpoint, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(groq.model, 'llama-3.3-70b-versatile');
  assert.equal(groq.requiresApiKey, true);

  const local = resolveProviderConfig({ provider: 'local' });
  assert.equal(local.ok, true);
  assert.equal(local.protocol, 'openai');
  assert.equal(local.endpoint, 'http://localhost:11434/v1/chat/completions');
  assert.equal(local.requiresApiKey, false);

  const custom = resolveProviderConfig({
    protocol: 'anthropic',
    endpoint: 'https://custom-proxy.internal/v1/messages',
    model: 'custom-claude'
  });
  assert.equal(custom.ok, true);
  assert.equal(custom.protocol, 'anthropic');
  assert.equal(custom.endpoint, 'https://custom-proxy.internal/v1/messages');
  assert.equal(custom.model, 'custom-claude');

  const disallowed = resolveProviderConfig({
    endpoint: 'http://insecure-external.com/v1'
  });
  assert.equal(disallowed.ok, false);
  assert.match(disallowed.error, /localhost or 127\.0\.0\.1/);
});

/* ---------------- 6. HTTP Adapter & Invocations ---------------- */

test('http adapter check verifies endpoint security and required credentials', async () => {
  const adapter = createHttpAdapter({ provider: 'openai' });

  // Missing API key for OpenAI
  const checkNoKey = await adapter.check({}, {});
  assert.equal(checkNoKey.ok, false);
  assert.match(checkNoKey.error, /API key is required/);

  // Valid with API key
  const checkWithKey = await adapter.check({ apiKey: 'sk-test' }, {});
  assert.equal(checkWithKey.ok, true);
  assert.equal(checkWithKey.version, 'HTTP/openai');

  // Disallowed remote HTTP endpoint
  const checkDisallowed = await adapter.check({ endpoint: 'http://api.remote.com/v1' }, {});
  assert.equal(checkDisallowed.ok, false);
  assert.match(checkDisallowed.error, /localhost or 127\.0\.0\.1/);

  // Local Ollama does not require API key
  const localAdapter = createHttpAdapter({ provider: 'ollama' });
  const checkLocal = await localAdapter.check({}, {});
  assert.equal(checkLocal.ok, true);
});

test('invokeHttp executes successfully with mock fetch (OpenAI format)', async () => {
  const mockFetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(options.headers['authorization'], 'Bearer sk-test-val');
    return {
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"coach_contract":1,"ok":true}' } }]
      })
    };
  };

  const res = await invokeHttp({
    endpoint: 'https://api.openai.com/v1/chat/completions',
    protocol: 'openai',
    apiKey: 'sk-test-val',
    model: 'gpt-4o',
    prompt: 'ping',
    fetchFn: mockFetch
  });

  assert.equal(res.code, 0);
  assert.equal(res.text, '{"coach_contract":1,"ok":true}');
  assert.equal(res.timedOut, false);
  assert.equal(res.spawnError, false);
});

test('invokeHttp executes successfully with mock fetch (Anthropic format)', async () => {
  const mockFetch = async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], 'sk-ant-test');
    return {
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: 'text', text: '{"coach_contract":1,"ok":true}' }]
      })
    };
  };

  const res = await invokeHttp({
    endpoint: 'https://api.anthropic.com/v1/messages',
    protocol: 'anthropic',
    apiKey: 'sk-ant-test',
    model: 'claude-3-7-sonnet-latest',
    prompt: 'ping',
    fetchFn: mockFetch
  });

  assert.equal(res.code, 0);
  assert.equal(res.text, '{"coach_contract":1,"ok":true}');
  assert.equal(res.timedOut, false);
  assert.equal(res.spawnError, false);
});

test('invokeHttp handles 401 Unauthorized cleanly', async () => {
  const mockFetch = async () => ({
    status: 401,
    text: async () => JSON.stringify({
      error: { message: 'Invalid API key' }
    })
  });

  const res = await invokeHttp({
    endpoint: 'https://api.openai.com/v1/chat/completions',
    protocol: 'openai',
    apiKey: 'bad-key',
    model: 'gpt-4o',
    prompt: 'ping',
    fetchFn: mockFetch
  });

  assert.equal(res.code, 1);
  assert.equal(res.text, '');
  assert.match(res.stderr, /Invalid API key/);
  assert.equal(res.timedOut, false);
  assert.equal(res.spawnError, false);
});

test('invokeHttp handles request timeout cleanly', async () => {
  const mockFetch = async (url, { signal }) => {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const res = await invokeHttp({
    endpoint: 'https://api.openai.com/v1/chat/completions',
    protocol: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o',
    prompt: 'ping',
    timeoutMs: 50,
    fetchFn: mockFetch
  });

  assert.equal(res.code, -1);
  assert.equal(res.timedOut, true);
  assert.equal(res.spawnError, false);
  assert.match(res.stderr, /timed out/);
});

test('invokeHttp handles network/connection failure as spawnError', async () => {
  const mockFetch = async () => {
    throw new Error('fetch failed: ECONNREFUSED');
  };

  const res = await invokeHttp({
    endpoint: 'http://localhost:11434/v1/chat/completions',
    protocol: 'openai',
    model: 'llama3.2',
    prompt: 'ping',
    fetchFn: mockFetch
  });

  assert.equal(res.code, -1);
  assert.equal(res.timedOut, false);
  assert.equal(res.spawnError, true);
  assert.match(res.stderr, /ECONNREFUSED/);
});

/* ---------------- 7. Adapter Factory and Registry Integration ---------------- */

test('adapterFor resolves existing and new providers properly', () => {
  // Existing adapters remain intact
  assert.equal(adapterFor('claude')?.id, 'claude');
  assert.equal(adapterFor('codex')?.id, 'codex');
  assert.equal(adapterFor('fixture')?.id, 'fixture');

  // New provider presets resolve to http adapters
  assert.equal(adapterFor('anthropic')?.id, 'anthropic');
  assert.equal(adapterFor('openai')?.id, 'openai');
  assert.equal(adapterFor('groq')?.id, 'groq');
  assert.equal(adapterFor('openrouter')?.id, 'openrouter');
  assert.equal(adapterFor('mistral')?.id, 'mistral');
  assert.equal(adapterFor('ollama')?.id, 'ollama');
  assert.equal(adapterFor('local')?.id, 'ollama');
  assert.equal(adapterFor('http')?.id, 'http');

  // Unknown returns null
  assert.equal(adapterFor('nonexistent'), null);
});
