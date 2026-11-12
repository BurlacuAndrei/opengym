#!/usr/bin/env node
/* Imports yoga poses (from alexcumplido/yoga-api) and deduplicated exercises
 * (from yuhonas/free-exercise-db) into frontend/src/lib/exercises-data.js,
 * tags all exercises with categories ('strength', 'yoga', 'stretching',
 * 'plyometrics', 'cardio'), bundles CC0 vector SVGs for yoga poses,
 * and regenerates api/coach/library.json.
 *
 * Usage:
 *   node scripts/import-exercises.mjs
 *   node scripts/import-exercises.mjs [path-to-yoga.json] [path-to-free.json] [path-to-svgs-dir]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exdbPath = join(root, 'frontend', 'src', 'lib', 'exercises-data.js');
const coachLibPath = join(root, 'shared', 'coach', 'library.json');

const YOGA_API_URL = 'https://yoga-api-nzy4.onrender.com/v1/poses';
const FREE_DB_URL = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';

// Normalization helper for name deduplication
export const normalizeName = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Equipment mapping from free-exercise-db to OpenGym
const EQ_MAP = {
  'body only': 'body weight',
  'foam roll': 'roller',
  'exercise ball': 'stability ball',
  'medicine ball': 'medicine ball',
  'dumbbell': 'dumbbell',
  'machine': 'leverage machine',
  'cable': 'cable',
  'barbell': 'barbell',
  'e-z curl bar': 'ez barbell',
  'kettlebells': 'kettlebell',
  'bands': 'band'
};

// Muscle mapping from free-exercise-db primaryMuscles to OpenGym body part and target
const MUSCLE_MAP = {
  abdominals: { bp: 'waist', tg: 'abs', mg: 'abs' },
  hamstrings: { bp: 'upper legs', tg: 'hamstrings', mg: 'hamstrings' },
  quadriceps: { bp: 'upper legs', tg: 'quads', mg: 'quads' },
  glutes: { bp: 'upper legs', tg: 'glutes', mg: 'glutes' },
  abductors: { bp: 'upper legs', tg: 'glutes', mg: 'glutes' },
  adductors: { bp: 'upper legs', tg: 'adductors', mg: 'adductors' },
  calves: { bp: 'lower legs', tg: 'calves', mg: 'calves' },
  shoulders: { bp: 'shoulders', tg: 'delts', mg: 'delts' },
  chest: { bp: 'chest', tg: 'pectorals', mg: 'pectorals' },
  biceps: { bp: 'upper arms', tg: 'biceps', mg: 'biceps' },
  triceps: { bp: 'upper arms', tg: 'triceps', mg: 'triceps' },
  forearms: { bp: 'lower arms', tg: 'forearms', mg: 'forearms' },
  'lower back': { bp: 'back', tg: 'spine', mg: 'spine' },
  'middle back': { bp: 'back', tg: 'upper back', mg: 'upper back' },
  lats: { bp: 'back', tg: 'lats', mg: 'lats' },
  neck: { bp: 'neck', tg: 'traps', mg: 'traps' }
};

export async function fetchOrRead(cliArg, cachePath, remoteUrl) {
  if (cliArg && existsSync(cliArg)) {
    return JSON.parse(readFileSync(cliArg, 'utf8'));
  }
  if (cachePath && existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  console.log(`Fetching from ${remoteUrl}…`);
  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${remoteUrl}`);
  return await res.json();
}

export async function fetchOrReadSvg(pose, cliSvgDir, cacheSvgDir) {
  const localFile = cliSvgDir ? join(cliSvgDir, `${pose.id}.svg`) : (cacheSvgDir ? join(cacheSvgDir, `${pose.id}.svg`) : null);
  if (localFile && existsSync(localFile)) {
    return cleanSvg(readFileSync(localFile, 'utf8'));
  }
  if (!pose.url_svg) return '';
  console.log(`Fetching SVG for pose ${pose.id}: ${pose.english_name}…`);
  const res = await fetch(pose.url_svg);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching SVG from ${pose.url_svg}`);
  const raw = await res.text();
  if (cacheSvgDir) {
    mkdirSync(cacheSvgDir, { recursive: true });
    writeFileSync(join(cacheSvgDir, `${pose.id}.svg`), raw);
  }
  return cleanSvg(raw);
}

export function cleanSvg(svgText) {
  return (svgText || '')
    .replace(/<\?xml.*?\?>\s*/i, '')
    .replace(/<!DOCTYPE.*?>\s*/i, '')
    .trim();
}

export async function run() {
  const customYogaArg = process.argv[2];
  const customFreeArg = process.argv[3];
  const customSvgDirArg = process.argv[4];

  // 1. Read existing EXDB
  const exdbFileContent = readFileSync(exdbPath, 'utf8');
  const match = exdbFileContent.match(/export const EXDB=(\[[\s\S]*\]);?/);
  if (!match) throw new Error(`Could not parse EXDB array in ${exdbPath}`);
  const existingEXDB = JSON.parse(match[1]);
  console.log(`Read ${existingEXDB.length} existing exercises from ${exdbPath}`);

  // Tag existing exercises with categories
  const taggedExisting = existingEXDB.map(e => ({
    ...e,
    cat: e.cat || (e.bp === 'cardio' ? 'cardio' : (e.n.toLowerCase().includes('stretch') ? 'stretching' : 'strength'))
  }));

  const existingNorms = new Set(existingEXDB.map(e => normalizeName(e.n)));

  // 2. Fetch / load yoga poses
  const yogaData = await fetchOrRead(customYogaArg, '/tmp/yoga_poses.json', YOGA_API_URL);
  const yogaPosesList = Array.isArray(yogaData) ? yogaData : (yogaData.poses || []);
  console.log(`Loaded ${yogaPosesList.length} yoga poses`);

  const yogaExercises = [];
  for (const p of yogaPosesList) {
    const svg = await fetchOrReadSvg(p, customSvgDirArg, '/tmp/yoga_svgs');

    // Taxonomy inference based on pose benefits / description
    const text = ((p.pose_description || '') + ' ' + (p.pose_benefits || '')).toLowerCase();
    let bp = 'waist';
    let tg = 'abs';
    let mg = 'abs';
    if (text.includes('hamstring') || text.includes('quad') || text.includes('thigh') || text.includes('leg')) {
      bp = 'upper legs'; tg = 'quads'; mg = 'quads';
    } else if (text.includes('spine') || text.includes('back')) {
      bp = 'back'; tg = 'spine'; mg = 'spine';
    } else if (text.includes('shoulder') || text.includes('arm') || text.includes('chest')) {
      bp = 'shoulders'; tg = 'delts'; mg = 'delts';
    }

    const steps = (p.pose_description || '')
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean);

    const sanskrit = p.sanskrit_name_adapted || p.sanskrit_name;
    const name = sanskrit
      ? `${p.english_name} (${sanskrit})`.toLowerCase()
      : p.english_name.toLowerCase();

    yogaExercises.push({
      id: `yoga-${p.id}`,
      n: name,
      bp,
      eq: 'body weight',
      tg,
      mg,
      sm: [],
      st: steps,
      cat: 'yoga',
      svg,
      img: '',
      gif: ''
    });
  }

  // 3. Fetch / load free-exercise-db
  const freeData = await fetchOrRead(customFreeArg, '/tmp/free_exercises.json', FREE_DB_URL);
  console.log(`Loaded ${freeData.length} free-exercise-db records`);

  // Target categories from free-exercise-db: stretching, plyometrics, cardio
  const relevantCategories = new Set(['stretching', 'plyometrics', 'cardio']);
  const relevantFree = freeData.filter(e => relevantCategories.has(e.category));
  console.log(`Found ${relevantFree.length} exercises in stretching, plyometrics, and cardio`);

  const freeExercises = [];
  const seenNames = new Set(existingNorms);
  let duplicateCount = 0;

  for (const f of relevantFree) {
    const key = normalizeName(f.name);
    if (seenNames.has(key)) {
      duplicateCount++;
      continue;
    }
    seenNames.add(key);

    let bpInfo = { bp: 'waist', tg: 'abs', mg: 'abs' };
    if (f.category === 'cardio') {
      bpInfo = { bp: 'cardio', tg: 'cardiovascular system', mg: 'cardiovascular system' };
    } else if (f.primaryMuscles && f.primaryMuscles[0] && MUSCLE_MAP[f.primaryMuscles[0]]) {
      bpInfo = MUSCLE_MAP[f.primaryMuscles[0]];
    }

    const eq = EQ_MAP[f.equipment] || 'body weight';

    freeExercises.push({
      id: `fedb-${f.id.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`,
      n: f.name.toLowerCase(),
      bp: bpInfo.bp,
      eq,
      tg: bpInfo.tg,
      mg: bpInfo.mg,
      sm: f.secondaryMuscles || [],
      st: f.instructions || [],
      cat: f.category,
      img: '',
      gif: ''
    });
  }

  console.log(`Deduplicated: skipped ${duplicateCount} duplicate exercises, importing ${freeExercises.length} unique exercises`);

  // 4. Merge all
  const combined = [...taggedExisting, ...yogaExercises, ...freeExercises];

  // Verify ID uniqueness
  const idSet = new Set();
  for (const ex of combined) {
    if (idSet.has(ex.id)) throw new Error(`Duplicate exercise ID detected: ${ex.id}`);
    idSet.add(ex.id);
  }

  // Write updated exercises-data.js
  const outCode = `export const EXDB=${JSON.stringify(combined)};\n`;
  writeFileSync(exdbPath, outCode);
  console.log(`Wrote ${exdbPath} (${combined.length} total exercises, ${(outCode.length / 1024).toFixed(0)} KB)`);

  // 5. Update shared/coach/library.json
  const coachIndex = combined.map(e => ({ id: e.id, n: e.n, bp: e.bp, tg: e.tg, eq: e.eq }));
  const coachJson = JSON.stringify({
    generated_from: 'frontend/src/lib/exercises-data.js',
    count: coachIndex.length,
    exercises: coachIndex
  }) + '\n';
  writeFileSync(coachLibPath, coachJson);
  console.log(`Wrote ${coachLibPath} (${coachIndex.length} exercises)`);

  // Category summary
  const catSummary = {};
  for (const e of combined) {
    catSummary[e.cat] = (catSummary[e.cat] || 0) + 1;
  }
  console.log('Category distribution:', catSummary);
}

// Execute when run as script
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
