import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempData, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const auth = await import('../coach/oauth.js');
const cadence = await import('../coach/cadence.js');

/* ---------------- configuration ---------------- */

test('an unconfigured instance offers nothing at all', () => {
  assert.equal(cfg.isEnabled(), false);
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.publicConfig(), null, 'no coach key in /api/config ⇒ no Coach UI anywhere');
});

test('a provider that is enabled but not signed in is still not offered', () => {
  cfg.save({ enabled: true, provider: 'claude' });
  assert.equal(cfg.isEnabled(), true);
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.publicConfig(), null, 'half-configured is off, not broken');
});

test('credentials survive a round-trip and are unreadable in the file', () => {
  cfg.save({ enabled: true, provider: 'claude', auth: { type: 'cli-token', data: cfg.encrypt({ token: 'cli-setup-secret' }) } });
  assert.equal(cfg.isConnected(), true);
  const onDisk = fs.readFileSync(`${DIR}/coach.json`, 'utf8');
  assert.ok(!onDisk.includes('cli-setup-secret'), 'the token is not sitting in the file in the clear');
  assert.equal(cfg.decrypt(cfg.load().auth.data).token, 'cli-setup-secret');
});

test('a credential encrypted under a different secret fails closed', () => {
  const blob = cfg.encrypt({ token: 'sk-ant-secret' });
  fs.writeFileSync(`${DIR}/secret`, 'b'.repeat(64));
  cfg.reset();
  assert.equal(cfg.decrypt(blob), null, 'restoring ./data without its secret does not leak the token');
  fs.writeFileSync(`${DIR}/secret`, 'a'.repeat(64));
  cfg.reset();
});

test('a Claude Code setup token is encrypted and reaches only the Agent SDK environment', () => {
  cfg.save({ enabled: true, provider: 'claude', auth: null });
  auth.setSetupToken('cli-setup-tok');
  assert.equal(cfg.load().auth.type, 'cli-token');
  assert.equal(auth.authStatus().type, 'cli-token');
  process.env.RP_ID = 'gym.example.com';
  process.env.ADMIN_UIDS = 'someadmin';
  const env = cfg.jobEnv('/tmp/jobdir');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'cli-setup-tok');
  assert.equal(env.HOME, '/tmp/jobdir', 'the Agent SDK writes any transient state into the job dir');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/jobdir');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(env.RP_ID, undefined, 'nothing is inherited from this process');
  assert.equal(env.ADMIN_UIDS, undefined);
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'TMPDIR']);
});

test('retired Gemini and Custom command configurations reset to unconfigured Claude', () => {
  cfg.save({
    enabled: true,
    provider: 'gemini',
    customCommand: '/usr/local/bin/my-coach',
    auth: { type: 'apikey', data: cfg.encrypt({ token: 'gemini-key' }) }
  });
  cfg.reset();
  const current = cfg.load();
  assert.deepEqual(Object.keys(cfg.PROVIDERS).sort(), ['anthropic', 'claude', 'codex', 'fixture', 'groq', 'mistral', 'ollama', 'openai', 'openrouter']);
  assert.equal(current.provider, 'claude');
  assert.equal(current.auth, null);
  assert.equal(Object.hasOwn(current, 'customCommand'), false);
  assert.equal(cfg.isConnected(), false);
});

test('Codex uses its own ChatGPT CLI cache and never receives an API key', () => {
  cfg.save({ enabled: true, provider: 'codex', auth: { type: 'apikey', data: cfg.encrypt({ token: 'legacy-openai-key' }) } });
  cfg.ensureCodexHome();
  const codexConfig = fs.readFileSync(`${cfg.codexHome()}/config.toml`, 'utf8');
  assert.match(codexConfig, /shell_tool = false/);
  assert.match(codexConfig, /":root" = "deny"/);
  fs.writeFileSync(cfg.codexAuthFile(), '{}', { mode: 0o600 });

  assert.equal(cfg.isConnected(), true);
  assert.equal(auth.authStatus().type, 'chatgpt-cli');
  assert.throws(() => auth.setApiKey('sk-not-used'), /ChatGPT/);

  const env = cfg.jobEnv('/tmp/jobdir');
  assert.equal(env.CODEX_HOME, cfg.codexHome());
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.HOME, '/tmp/jobdir', 'the agent has no access to the persistent cache through HOME');
  fs.unlinkSync(cfg.codexAuthFile());
  assert.equal(cfg.isConnected(), false, 'a removed Codex cache fails closed');
});

test('legacy Claude credentials are disabled until replaced with a setup token', () => {
  cfg.save({ enabled: true, provider: 'claude', auth: { type: 'apikey', data: cfg.encrypt({ token: 'sk-ant-key' }) } });
  assert.equal(cfg.isConnected(), false);
  assert.equal(auth.authStatus().state, 'replace-required');
  const env = cfg.jobEnv('/tmp/jobdir');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.throws(() => auth.setApiKey('sk-ant-key'), /setup token/);
});

test('the instance job log records outcomes, never contents', () => {
  cfg.save({ log: [] });
  cfg.logJob({ at: new Date().toISOString(), uid: 'u1', kind: 'review', outcome: 'ready', ms: 1200 });
  cfg.logJob({ at: new Date().toISOString(), uid: 'u1', kind: 'review', outcome: 'failed', errorClass: 'auth', ms: 400 });
  const log = cfg.load().log;
  assert.equal(log.length, 2);
  assert.equal(cfg.lastError().errorClass, 'auth');
  assert.equal(cfg.lastSuccess().outcome, 'ready');
  assert.ok(!JSON.stringify(log).includes('changes'), 'no proposal content ever reaches the instance log');
});

/* ---------------- cadence ---------------- */

const coachWith = over => ({ consent: { agreedAt: '2026-01-01T00:00:00Z' }, ...over });

test('cadence off never fires', () => {
  assert.equal(cadence.isDue(coachWith({ cadence: 'off' }), sampleState(), null), false);
  assert.equal(cadence.isDue(coachWith({}), sampleState(), null), false);
});

test('no new training since the last review means nothing to review', () => {
  const S = sampleState();
  const coach = coachWith({ cadence: { everyWorkouts: 1 }, lastReview: { at: Date.now() } });
  assert.equal(cadence.isDue(coach, S, null), false);
});

test('every-N-workouts fires once the count is met', () => {
  const S = sampleState();
  S.workouts = [1, 2, 3].map(i => ({ id: 'w' + i, d: '2026-07-2' + i, end: Date.now(), entries: [] }));
  assert.equal(cadence.isDue(coachWith({ cadence: { everyWorkouts: 4 } }), S, null), false);
  assert.equal(cadence.isDue(coachWith({ cadence: { everyWorkouts: 3 } }), S, null), true);
});

test('weekly fires on the chosen weekday and minute, in the user\'s own timezone', () => {
  const S = sampleState();
  S.workouts = [{ id: 'w1', d: '2026-07-25', end: Date.now(), entries: [] }];
  const coach = coachWith({ cadence: { weekly: { day: 0, time: '18:00' } } });
  assert.equal(cadence.isDue(coach, S, { date: '2026-07-26', hhmm: '18:00', weekday: 0 }), true);
  assert.equal(cadence.isDue(coach, S, { date: '2026-07-26', hhmm: '17:59', weekday: 0 }), false);
  assert.equal(cadence.isDue(coach, S, { date: '2026-07-27', hhmm: '18:00', weekday: 1 }), false);
});

test('weekly does not fire twice on the same day', () => {
  const S = sampleState();
  S.workouts = [{ id: 'w1', d: '2026-07-25', end: Date.now(), entries: [] }];
  const coach = coachWith({
    cadence: { weekly: { day: 0, time: '18:00' } },
    lastReview: { at: new Date('2026-07-26T18:00:00Z').getTime() }
  });
  assert.equal(cadence.isDue(coach, S, { date: '2026-07-26', hhmm: '18:00', weekday: 0 }), false);
});

test('shared coach exports isDue matching server cadence', async () => {
  const shared = await import('shared/coach');
  assert.equal(cadence.isDue, shared.isDue);
});

/* ---------------- HTTP provider support (Issue #71) ---------------- */

test('HTTP provider registry initializes and exposes standard presets (Issue #71)', () => {
  const expectedProviders = ['anthropic', 'claude', 'codex', 'fixture', 'groq', 'mistral', 'ollama', 'openai', 'openrouter'];
  assert.deepEqual(Object.keys(cfg.PROVIDERS).sort(), expectedProviders);

  // Anthropic HTTP
  assert.equal(cfg.PROVIDERS.anthropic.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(cfg.PROVIDERS.anthropic.requiresApiKey, true);

  // OpenAI HTTP
  assert.equal(cfg.PROVIDERS.openai.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(cfg.PROVIDERS.openai.requiresApiKey, true);

  // Groq HTTP
  assert.equal(cfg.PROVIDERS.groq.apiKeyEnv, 'GROQ_API_KEY');
  assert.equal(cfg.PROVIDERS.groq.requiresApiKey, true);

  // OpenRouter HTTP
  assert.equal(cfg.PROVIDERS.openrouter.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(cfg.PROVIDERS.openrouter.requiresApiKey, true);

  // Mistral HTTP
  assert.equal(cfg.PROVIDERS.mistral.apiKeyEnv, 'MISTRAL_API_KEY');
  assert.equal(cfg.PROVIDERS.mistral.requiresApiKey, true);

  // Ollama HTTP (local, no API key required)
  assert.equal(cfg.PROVIDERS.ollama.apiKeyEnv, null);
  assert.equal(cfg.PROVIDERS.ollama.requiresApiKey, false);
  assert.equal(cfg.PROVIDERS.ollama.local, true);
});

test('HTTP provider configuration validation (Issue #71)', () => {
  // Valid configurations
  assert.equal(cfg.validateConfig({ enabled: true, provider: 'openai' }).ok, true);
  assert.equal(cfg.validateConfig({ provider: 'ollama', endpoint: 'http://localhost:11434/v1/chat/completions' }).ok, true);
  assert.equal(cfg.validateConfig({ provider: 'groq', model: 'llama-3.3-70b-versatile' }).ok, true);

  // Invalid configurations
  assert.equal(cfg.validateConfig(null).ok, false);
  assert.equal(cfg.validateConfig({ provider: 'nonexistent-provider' }).ok, false);
  assert.equal(cfg.validateConfig({ endpoint: 'http://remote.example.com/api' }).ok, false, 'rejects remote plaintext HTTP');
  assert.equal(cfg.validateConfig({ caps: 'invalid' }).ok, false);
});

test('HTTP provider switching resets auth and updates capability flags (Issue #71)', () => {
  // 1. Configure OpenAI with API key
  cfg.save({
    enabled: true,
    provider: 'openai',
    auth: { type: 'apikey', connectedAt: new Date().toISOString(), data: cfg.encrypt({ token: 'sk-test-key-openai' }) }
  });
  assert.equal(cfg.isEnabled(), true);
  assert.equal(cfg.isConnected(), true);
  assert.equal(auth.authStatus().state, 'connected');
  assert.deepEqual(cfg.publicConfig(), { enabled: true, provider: 'openai', providerLabel: 'OpenAI' });

  // 2. Switch to Groq -> auth is cleared (belongs to old provider)
  const validation = cfg.validateConfig({ provider: 'groq' });
  assert.equal(validation.ok, true);
  const patch = validation.patch;
  if (patch.provider !== cfg.load().provider) patch.auth = null;
  cfg.save(patch);

  assert.equal(cfg.load().provider, 'groq');
  assert.equal(cfg.load().auth, null);
  assert.equal(cfg.isConnected(), false);
  assert.equal(auth.authStatus().state, 'disconnected');
  assert.equal(cfg.publicConfig(), null, 'disconnected provider drops coach from /api/config');

  // 3. Set Groq key -> connected again
  auth.setApiKey('gsk-test-key-groq');
  assert.equal(cfg.isConnected(), true);
  assert.equal(auth.authStatus().state, 'connected');
  assert.deepEqual(cfg.publicConfig(), { enabled: true, provider: 'groq', providerLabel: 'Groq' });

  // 4. Switch to Ollama (local provider, requiresApiKey: false)
  const toOllama = cfg.validateConfig({ provider: 'ollama' }).patch;
  if (toOllama.provider !== cfg.load().provider) toOllama.auth = null;
  cfg.save(toOllama);

  assert.equal(cfg.load().provider, 'ollama');
  assert.equal(cfg.isConnected(), true, 'Ollama connects without credentials');
  assert.equal(auth.authStatus().state, 'not-required');
  assert.deepEqual(cfg.publicConfig(), { enabled: true, provider: 'ollama', providerLabel: 'Ollama (Local)' });

  // 5. Turn coach off -> capability flag dropped
  cfg.save({ enabled: false });
  assert.equal(cfg.isEnabled(), false);
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.publicConfig(), null);
});

test('HTTP provider jobEnv injects provider API key without process leakage (Issue #71)', () => {
  cfg.save({
    enabled: true,
    provider: 'anthropic',
    auth: { type: 'apikey', data: cfg.encrypt({ token: 'sk-ant-http-secret' }) }
  });
  const env = cfg.jobEnv('/tmp/coach-http-job');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-http-secret');
  assert.equal(env.COACH_API_KEY, 'sk-ant-http-secret');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GROQ_API_KEY, undefined);
  assert.equal(env.HOME, '/tmp/coach-http-job');
});
