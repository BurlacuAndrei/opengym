import test from 'node:test';
import assert from 'node:assert/strict';

import {
  repairRunner,
  testConnection,
  formatRepairPrompt,
  extractCallerText,
  resolveEndpointFromBaseUrl
} from './repair.js';

import * as sharedIndex from './index.js';
import { validatePlan, validateReview } from './validate.js';
import { PROTOCOLS } from './providers.js';

/* ---------------- 1. Module Exports ---------------- */

test('shared coach exports repair interfaces matching specification', () => {
  assert.equal(typeof sharedIndex.repairRunner, 'function');
  assert.equal(typeof sharedIndex.testConnection, 'function');
  assert.equal(typeof sharedIndex.formatRepairPrompt, 'function');
  assert.equal(typeof sharedIndex.extractCallerText, 'function');
  assert.equal(typeof sharedIndex.resolveEndpointFromBaseUrl, 'function');
});

/* ---------------- 2. Helper Functions ---------------- */

test('resolveEndpointFromBaseUrl resolves endpoints correctly', () => {
  assert.equal(
    resolveEndpointFromBaseUrl('http://localhost:11434', PROTOCOLS.OPENAI),
    'http://localhost:11434/v1/chat/completions'
  );
  assert.equal(
    resolveEndpointFromBaseUrl('https://api.openai.com/v1', PROTOCOLS.OPENAI),
    'https://api.openai.com/v1/chat/completions'
  );
  assert.equal(
    resolveEndpointFromBaseUrl('https://api.anthropic.com/v1', PROTOCOLS.ANTHROPIC),
    'https://api.anthropic.com/v1/messages'
  );
  assert.equal(
    resolveEndpointFromBaseUrl('https://api.anthropic.com', PROTOCOLS.ANTHROPIC),
    'https://api.anthropic.com/v1/messages'
  );
  assert.equal(
    resolveEndpointFromBaseUrl('https://custom.ai/chat/completions', PROTOCOLS.OPENAI),
    'https://custom.ai/chat/completions'
  );
  assert.equal(resolveEndpointFromBaseUrl(null), null);
  assert.equal(resolveEndpointFromBaseUrl(''), null);
});

test('formatRepairPrompt injects previous output and structured errors', () => {
  const originalPrompt = '# Original Task';
  const previous = '{"bad": true}';
  const errors = ['routines must be non-empty', 'missing why rationale'];

  const formatted = formatRepairPrompt({ originalPrompt, previous, errors });
  assert.ok(formatted.includes('# Original Task'));
  assert.ok(formatted.includes('# REPAIR REQUEST'));
  assert.ok(formatted.includes('{"bad": true}'));
  assert.ok(formatted.includes('- routines must be non-empty'));
  assert.ok(formatted.includes('- missing why rationale'));
});

test('extractCallerText handles multiple response shapes', () => {
  assert.equal(extractCallerText('hello world'), 'hello world');
  assert.equal(extractCallerText({ text: 'hello text' }), 'hello text');
  assert.equal(extractCallerText({ raw: 'hello raw' }), 'hello raw');
  assert.equal(extractCallerText({ content: 'hello content' }), 'hello content');
  assert.equal(
    extractCallerText({ content: [{ type: 'text', text: 'anthropic chunk' }] }),
    'anthropic chunk'
  );
  assert.equal(
    extractCallerText({ choices: [{ message: { content: 'openai choice' } }] }),
    'openai choice'
  );
  assert.equal(extractCallerText(null), '');
  assert.equal(extractCallerText(undefined), '');
});

/* ---------------- 3. repairRunner ---------------- */

test('repairRunner succeeds on first attempt without repair if JSON and schema are valid', async () => {
  let calls = 0;
  const caller = async ({ prompt }) => {
    calls++;
    return '{"status": "ok", "count": 42}';
  };

  const schemaValidator = (val) => {
    return val.status === 'ok' ? { ok: true, data: val } : { ok: false, errors: ['bad status'] };
  };

  const res = await repairRunner({
    caller,
    schemaValidator,
    prompt: 'Give me JSON',
    systemPrompt: 'Be concise'
  });

  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(res.repaired, false);
  assert.deepEqual(res.value, { status: 'ok', count: 42 });
  assert.equal(calls, 1);
});

test('repairRunner repairs on 1st retry when first attempt is malformed JSON', async () => {
  let callCount = 0;
  const receivedPrompts = [];

  const caller = async (arg) => {
    callCount++;
    receivedPrompts.push(arg.prompt);
    if (callCount === 1) {
      return 'I cannot help you with that.\nHere is some non-json text';
    }
    return '```json\n{"status": "fixed"}\n```';
  };

  const schemaValidator = (val) => ({ ok: val.status === 'fixed' });

  const res = await repairRunner({
    caller,
    schemaValidator,
    prompt: 'Generate plan',
    maxRetries: 1
  });

  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(res.repaired, true);
  assert.deepEqual(res.value, { status: 'fixed' });
  assert.equal(callCount, 2);

  // Verify repair prompt was formatted and delivered to retry
  assert.equal(receivedPrompts[0], 'Generate plan');
  assert.ok(receivedPrompts[1].includes('# REPAIR REQUEST'));
  assert.ok(receivedPrompts[1].includes('I cannot help you with that'));
});

test('repairRunner repairs on 1st retry when first attempt fails schema validation', async () => {
  let callCount = 0;
  const receivedPrompts = [];

  const caller = async ({ prompt, systemPrompt, repair }) => {
    callCount++;
    receivedPrompts.push(prompt);
    if (callCount === 1) {
      return JSON.stringify({ action: 'unknown_action', steps: [] });
    }
    assert.ok(repair, 'Repair context should be supplied on retry');
    assert.deepEqual(repair.errors, ['Action must be update or create']);
    return JSON.stringify({ action: 'create', steps: [1, 2] });
  };

  const schemaValidator = (val) => {
    if (val.action !== 'create' && val.action !== 'update') {
      return { ok: false, errors: ['Action must be update or create'] };
    }
    return { ok: true, data: val };
  };

  const res = await repairRunner({
    caller,
    schemaValidator,
    prompt: 'Create exercise plan',
    systemPrompt: 'Coach bot',
    maxRetries: 1
  });

  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(res.repaired, true);
  assert.equal(res.data.action, 'create');
  assert.equal(callCount, 2);
  assert.ok(receivedPrompts[1].includes('- Action must be update or create'));
});

test('repairRunner returns clean failure on double failure (JSON syntax)', async () => {
  let callCount = 0;
  const caller = async () => {
    callCount++;
    return 'Definitely not JSON output';
  };

  const res = await repairRunner({
    caller,
    prompt: 'Generate plan',
    maxRetries: 1
  });

  assert.equal(res.ok, false);
  assert.equal(res.attempts, 2);
  assert.equal(res.repaired, false);
  assert.ok(Array.isArray(res.errors));
  assert.ok(res.errors.length > 0);
  assert.equal(callCount, 2);
});

test('repairRunner returns clean failure on double failure (schema validation)', async () => {
  let callCount = 0;
  const caller = async () => {
    callCount++;
    return JSON.stringify({ version: 1, invalidField: true });
  };

  const schemaValidator = () => ({
    ok: false,
    errors: ['Invalid schema: missing routines array']
  });

  const res = await repairRunner({
    caller,
    schemaValidator,
    prompt: 'Generate plan',
    maxRetries: 1
  });

  assert.equal(res.ok, false);
  assert.equal(res.attempts, 2);
  assert.equal(res.repaired, false);
  assert.deepEqual(res.errors, ['Invalid schema: missing routines array']);
  assert.equal(callCount, 2);
});

test('repairRunner returns clean failure on mixed failure (bad JSON then bad schema)', async () => {
  let callCount = 0;
  const caller = async () => {
    callCount++;
    if (callCount === 1) return 'Not JSON';
    return JSON.stringify({ foo: 'bar' });
  };

  const schemaValidator = () => ({
    ok: false,
    errors: ['foo is not acceptable']
  });

  const res = await repairRunner({
    caller,
    schemaValidator,
    prompt: 'Generate plan',
    maxRetries: 1
  });

  assert.equal(res.ok, false);
  assert.equal(res.attempts, 2);
  assert.deepEqual(res.errors, ['foo is not acceptable']);
});

test('repairRunner respects maxRetries = 0', async () => {
  let callCount = 0;
  const caller = async () => {
    callCount++;
    return 'Invalid JSON';
  };

  const res = await repairRunner({
    caller,
    prompt: 'Generate plan',
    maxRetries: 0
  });

  assert.equal(res.ok, false);
  assert.equal(res.attempts, 1);
  assert.equal(callCount, 1);
});

test('repairRunner handles caller returning explicit failure object', async () => {
  const caller = async () => ({ ok: false, error: 'HTTP 500 Internal Server Error' });

  const res = await repairRunner({
    caller,
    prompt: 'Generate plan'
  });

  assert.equal(res.ok, false);
  assert.equal(res.attempts, 1);
  assert.ok(res.error.includes('HTTP 500'));
});

test('repairRunner handles caller throwing exception cleanly', async () => {
  const caller = async () => {
    throw new Error('Network socket disconnected');
  };

  const res = await repairRunner({
    caller,
    prompt: 'Generate plan'
  });

  assert.equal(res.ok, false);
  assert.equal(res.attempts, 1);
  assert.ok(res.error.includes('Network socket disconnected'));
});

test('repairRunner supports caller that accesses prompt as string method', async () => {
  const caller = async (arg) => {
    assert.ok(typeof arg.indexOf === 'function');
    assert.ok(arg.includes('TestPrompt'));
    return '{"received": true}';
  };

  const res = await repairRunner({
    caller,
    prompt: 'TestPrompt'
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { received: true });
});

test('repairRunner integrates seamlessly with validatePlan', async () => {
  let callCount = 0;
  const caller = async () => {
    callCount++;
    if (callCount === 1) {
      // Missing routines
      return JSON.stringify({ nochange: false });
    }
    // Valid minimal plan bundle using an exercise from the library
    return JSON.stringify({
      routines: [{
        name: 'Full Body',
        ex: [{ id: '0001', sets: 3, reps: 10, mode: 'reps', weight: 60 }]
      }]
    });
  };

  const res = await repairRunner({
    caller,
    schemaValidator: (val) => validatePlan(val),
    prompt: 'Build plan'
  });

  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(res.repaired, true);
  assert.ok(res.data.routines);
});

/* ---------------- 4. testConnection ---------------- */

test('testConnection succeeds with valid OpenAI response structure', async () => {
  const mockFetch = async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['authorization'], 'Bearer test-key-123');
    const reqBody = JSON.parse(opts.body);
    assert.equal(reqBody.model, 'gpt-4o');

    return {
      status: 200,
      async text() {
        return JSON.stringify({
          id: 'chatcmpl-123',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
        });
      }
    };
  };

  const res = await testConnection({
    provider: 'openai',
    apiKey: 'test-key-123',
    fetchFn: mockFetch
  });

  assert.equal(res.ok, true);
  assert.equal(res.provider, 'openai');
  assert.equal(res.model, 'gpt-4o');
  assert.equal(res.text, 'pong');
  assert.equal(typeof res.latencyMs, 'number');
  assert.equal(res.usage?.total_tokens, 6);
});

test('testConnection succeeds with valid Anthropic response structure', async () => {
  const mockFetch = async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['x-api-key'], 'ant-key-999');
    const reqBody = JSON.parse(opts.body);
    assert.equal(reqBody.model, 'claude-3-7-sonnet-latest');

    return {
      status: 200,
      async text() {
        return JSON.stringify({
          id: 'msg_123',
          type: 'message',
          content: [{ type: 'text', text: 'pong' }],
          usage: { input_tokens: 4, output_tokens: 1 }
        });
      }
    };
  };

  const res = await testConnection({
    provider: 'anthropic',
    apiKey: 'ant-key-999',
    fetchFn: mockFetch
  });

  assert.equal(res.ok, true);
  assert.equal(res.provider, 'anthropic');
  assert.equal(res.text, 'pong');
});

test('testConnection succeeds for Ollama (local) without API key', async () => {
  const mockFetch = async (url, opts) => {
    assert.ok(url.startsWith('http://localhost:11434'));
    assert.equal(opts.headers['authorization'], undefined);

    return {
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: 'pong' } }]
        });
      }
    };
  };

  const res = await testConnection({
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    fetchFn: mockFetch
  });

  assert.equal(res.ok, true);
  assert.equal(res.provider, 'ollama');
  assert.equal(res.text, 'pong');
});

test('testConnection rejects remote plaintext HTTP endpoint', async () => {
  const res = await testConnection({
    provider: 'custom',
    baseUrl: 'http://api.remote-llm.com/v1',
    apiKey: 'some-key'
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes('Plaintext http:// is only allowed for localhost or 127.0.0.1'));
});

test('testConnection rejects missing API key for presets requiring it', async () => {
  const res = await testConnection({
    provider: 'openai'
    // no apiKey
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes('API key is required for OpenAI'));
});

test('testConnection handles HTTP 401 Unauthorized cleanly', async () => {
  const mockFetch = async () => ({
    status: 401,
    async text() {
      return JSON.stringify({
        error: { message: 'Incorrect API key provided' }
      });
    }
  });

  const res = await testConnection({
    provider: 'openai',
    apiKey: 'invalid-key',
    fetchFn: mockFetch
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.error, 'Incorrect API key provided');
});

test('testConnection handles network/connection failure cleanly', async () => {
  const mockFetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  };

  const res = await testConnection({
    provider: 'ollama',
    fetchFn: mockFetch
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes('ECONNREFUSED'));
});

test('testConnection handles request timeout cleanly', async () => {
  const mockFetch = async (url, opts) => {
    return new Promise((resolve, reject) => {
      opts.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const res = await testConnection({
    provider: 'openai',
    apiKey: 'test-key',
    timeoutMs: 25,
    fetchFn: mockFetch
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes('timed out'));
});

test('testConnection handles malformed / non-JSON response from server', async () => {
  const mockFetch = async () => ({
    status: 200,
    async text() {
      return '<html><head><title>Bad Gateway</title></head></html>';
    }
  });

  const res = await testConnection({
    provider: 'openai',
    apiKey: 'test-key',
    fetchFn: mockFetch
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes('Empty or non-JSON response'));
});

test('testConnection resolves custom baseUrl correctly', async () => {
  let invokedUrl = '';
  const mockFetch = async (url) => {
    invokedUrl = url;
    return {
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: 'pong' } }] });
      }
    };
  };

  await testConnection({
    provider: 'openai',
    baseUrl: 'https://custom-gateway.io/v1',
    apiKey: 'test-key',
    fetchFn: mockFetch
  });

  assert.equal(invokedUrl, 'https://custom-gateway.io/v1/chat/completions');
});
