#!/usr/bin/env node
/* Generates shared/coach/library.json from the frontend's exercise dataset.
 *
 *   node scripts/build-coach-library.mjs           # write
 *   node scripts/build-coach-library.mjs --check   # fail if stale (CI)
 *
 * Both the API and client Coach modules share this catalogue for validation and payload
 * generation. Rather than teach consumers to reach into frontend/ at runtime, the shared
 * index is generated and committed in shared/coach/library.json.
 *
 * Only the fields the Coach reasons over are kept: an id, a name, and the three taxonomy
 * fields it filters on. Instructions, images and secondary muscles stay out — they would
 * quadruple a payload the model has no use for.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'frontend', 'src', 'lib', 'exercises-data.js');
const out = join(root, 'shared', 'coach', 'library.json');

const { EXDB } = await import(pathToFileURL(src).href);
const index = EXDB.map(e => ({ id: e.id, n: e.n, bp: e.bp, tg: e.tg, eq: e.eq }));
const json = JSON.stringify({ generated_from: 'frontend/src/lib/exercises-data.js', count: index.length, exercises: index }) + '\n';

if (process.argv.includes('--check')) {
  let current = null;
  try { current = readFileSync(out, 'utf8'); } catch { /* missing counts as stale */ }
  if (current !== json) {
    console.error('shared/coach/library.json is out of date — run: node scripts/build-coach-library.mjs');
    process.exit(1);
  }
  console.log(`shared/coach/library.json in sync (${index.length} exercises).`);
} else {
  writeFileSync(out, json);
  console.log(`Wrote ${out} — ${index.length} exercises, ${(json.length / 1024).toFixed(0)} KB.`);
}
