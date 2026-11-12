import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMON_PROMPT,
  CREATE_PROMPT,
  REFINE_PROMPT,
  REPAIR_PROMPT,
  REVIEW_PROMPT,
  PROMPTS,
  buildPrompt
} from './prompts.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(dir, 'prompts');

test('every runtime prompt export matches its corresponding shared markdown file byte-for-byte', () => {
  const promptEntries = [
    { file: 'common.md', content: COMMON_PROMPT },
    { file: 'create.md', content: CREATE_PROMPT },
    { file: 'refine.md', content: REFINE_PROMPT },
    { file: 'repair.md', content: REPAIR_PROMPT },
    { file: 'review.md', content: REVIEW_PROMPT }
  ];

  for (const { file, content } of promptEntries) {
    const diskPath = path.join(promptsDir, file);
    assert.ok(fs.existsSync(diskPath), `Markdown file exists: ${file}`);
    const diskContent = fs.readFileSync(diskPath, 'utf8');
    assert.strictEqual(
      content,
      diskContent,
      `Prompt export for ${file} must match markdown file byte-for-byte`
    );
  }
});

test('PROMPTS dictionary matches every markdown file and exported constant', () => {
  const expectedKeys = ['common.md', 'create.md', 'refine.md', 'repair.md', 'review.md'];
  assert.deepStrictEqual(Object.keys(PROMPTS).sort(), expectedKeys.sort());

  for (const key of expectedKeys) {
    const diskContent = fs.readFileSync(path.join(promptsDir, key), 'utf8');
    assert.strictEqual(PROMPTS[key], diskContent);
  }
});

test('buildPrompt constructs valid prompt structures with payload and optional repair', () => {
  const reviewPrompt = buildPrompt('review', { foo: 'bar' });
  assert.ok(reviewPrompt.includes(COMMON_PROMPT));
  assert.ok(reviewPrompt.includes(REVIEW_PROMPT));
  assert.ok(reviewPrompt.includes('"foo": "bar"'));

  const createPrompt = buildPrompt('create', { foo: 'bar' });
  assert.ok(createPrompt.includes(COMMON_PROMPT));
  assert.ok(createPrompt.includes(CREATE_PROMPT));

  const repairPrompt = buildPrompt('create', { foo: 'bar' }, {
    previous: 'bad-json',
    errors: ['Invalid schema']
  });
  assert.ok(repairPrompt.includes('bad-json'));
  assert.ok(repairPrompt.includes('- Invalid schema'));
});
