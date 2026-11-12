import test from 'node:test';
import assert from 'node:assert/strict';
import {
  librarySlice,
  exerciseCategory,
  extractModalities,
  VALID_MODALITIES,
  LIBRARY,
  build,
  computeCardioSummaryAndLoad,
  acwrRiskCategory
} from './payload.js';
import { buildPrompt } from './prompts.js';

test('exerciseCategory determines correct category tag with strength default', () => {
  // Explicit cat property
  assert.equal(exerciseCategory({ cat: 'yoga' }), 'yoga');
  assert.equal(exerciseCategory({ cat: 'STRETCHING' }), 'stretching');
  assert.equal(exerciseCategory({ cat: '  cardio  ' }), 'cardio');

  // Explicit category property
  assert.equal(exerciseCategory({ category: 'plyometrics' }), 'plyometrics');
  assert.equal(exerciseCategory({ category: 'strength' }), 'strength');

  // Heuristics when cat/category is absent
  assert.equal(exerciseCategory({ id: 'yoga-1', bp: 'upper legs' }), 'yoga');
  assert.equal(exerciseCategory({ id: 'cardio-run', bp: 'cardio' }), 'cardio');
  assert.equal(exerciseCategory({ id: '1512', n: 'all fours squad stretch' }), 'stretching');
  assert.equal(exerciseCategory({ id: 'fedb-bench_jump', n: 'bench jump' }), 'plyometrics');

  // Default to strength when absent and no heuristic applies
  assert.equal(exerciseCategory({ id: '0001', n: 'barbell bench press', bp: 'chest' }), 'strength');
  assert.equal(exerciseCategory({}), 'strength');
  assert.equal(exerciseCategory(null), 'strength');
});

test('extractModalities parses modalities from arguments and state with strength fallback', () => {
  // Explicit array
  assert.deepEqual(extractModalities({}, ['yoga', 'stretching']), ['yoga', 'stretching']);

  // Explicit string / comma-delimited
  assert.deepEqual(extractModalities({}, 'plyometrics'), ['plyometrics']);
  assert.deepEqual(extractModalities({}, 'yoga, cardio'), ['yoga', 'cardio']);

  // From state intake / profile
  assert.deepEqual(extractModalities({ intake: { modalities: ['cardio'] } }), ['cardio']);
  assert.deepEqual(extractModalities({ coach: { profile: { modalities: ['yoga'] } } }), ['yoga']);
  assert.deepEqual(extractModalities({ profile: { modality: 'stretching' } }), ['stretching']);

  // From state plan / routines
  assert.deepEqual(extractModalities({ plan: { modalities: ['plyometrics'] } }), ['plyometrics']);
  assert.deepEqual(extractModalities({ routines: [{ modality: 'yoga' }] }), ['yoga']);
  assert.deepEqual(extractModalities({ routines: [{ ex: [{ cat: 'cardio' }] }] }), ['cardio']);

  // From active session
  assert.deepEqual(extractModalities({ active: { modality: 'yoga' } }), ['yoga']);

  // Fallback to ['strength'] when none specified
  assert.deepEqual(extractModalities({}, null), ['strength']);
  assert.deepEqual(extractModalities({}, []), ['strength']);
  assert.deepEqual(extractModalities({}), ['strength']);
});

test('librarySlice default preserves strength catalog when no modalities specified', () => {
  const defaultSlice = librarySlice({}, []);
  assert.ok(defaultSlice.length > 0, 'library has exercises');
  for (const ex of defaultSlice) {
    assert.equal(exerciseCategory(ex), 'strength', `all default exercises are strength: ${ex.id}`);
  }

  // Equipment filtering on default strength catalog
  const dumbbellStrength = librarySlice({}, ['dumbbell']);
  assert.ok(dumbbellStrength.length > 0 && dumbbellStrength.length < defaultSlice.length);
  for (const ex of dumbbellStrength) {
    assert.equal(ex.eq, 'dumbbell');
    assert.equal(exerciseCategory(ex), 'strength');
  }
});

test('librarySlice filters to specific modalities (yoga, stretching, plyometrics, cardio)', () => {
  // Yoga
  const yogaSlice = librarySlice({}, [], ['yoga']);
  assert.ok(yogaSlice.length > 0, 'has yoga exercises');
  for (const ex of yogaSlice) {
    assert.equal(exerciseCategory(ex), 'yoga');
  }

  // Stretching
  const stretchSlice = librarySlice({}, [], ['stretching']);
  assert.ok(stretchSlice.length > 0, 'has stretching exercises');
  for (const ex of stretchSlice) {
    assert.equal(exerciseCategory(ex), 'stretching');
  }

  // Plyometrics
  const plyoSlice = librarySlice({}, [], ['plyometrics']);
  assert.ok(plyoSlice.length > 0, 'has plyometrics exercises');
  for (const ex of plyoSlice) {
    assert.equal(exerciseCategory(ex), 'plyometrics');
  }

  // Cardio
  const cardioSlice = librarySlice({}, [], ['cardio']);
  assert.ok(cardioSlice.length > 0, 'has cardio exercises');
  for (const ex of cardioSlice) {
    assert.equal(exerciseCategory(ex), 'cardio');
  }
});

test('librarySlice supports multiple modalities and keeps payload compact', () => {
  const yogaSlice = librarySlice({}, [], ['yoga']);
  const stretchSlice = librarySlice({}, [], ['stretching']);
  const multiSlice = librarySlice({}, [], ['yoga', 'stretching']);

  assert.equal(multiSlice.length, yogaSlice.length + stretchSlice.length);
  for (const ex of multiSlice) {
    const cat = exerciseCategory(ex);
    assert.ok(cat === 'yoga' || cat === 'stretching', `category matches one of the requested: ${cat}`);
  }

  // Multi-modality payload is compact compared to full library
  assert.ok(multiSlice.length < LIBRARY.length, 'compact payload');
});

test('librarySlice supports options object parameter style', () => {
  const slice = librarySlice({}, { equipment: ['body weight'], modalities: ['yoga'] });
  assert.ok(slice.length > 0);
  for (const ex of slice) {
    assert.equal(ex.eq, 'body weight');
    assert.equal(exerciseCategory(ex), 'yoga');
  }
});

test('librarySlice filters custom exercises according to modality', () => {
  const S = {
    customEx: [
      { id: 'c_str', n: 'Custom Lift', bp: 'chest' }, // defaults to strength
      { id: 'c_yoga', n: 'Custom Asana', bp: 'back', cat: 'yoga' },
      { id: 'c_plyo', n: 'Custom Hop', bp: 'legs', category: 'plyometrics' }
    ]
  };

  // Default strength includes only c_str
  const strengthSlice = librarySlice(S, []);
  assert.ok(strengthSlice.some(e => e.id === 'c_str'));
  assert.ok(!strengthSlice.some(e => e.id === 'c_yoga'));
  assert.ok(!strengthSlice.some(e => e.id === 'c_plyo'));

  // Yoga includes only c_yoga
  const yogaSlice = librarySlice(S, [], ['yoga']);
  assert.ok(yogaSlice.some(e => e.id === 'c_yoga'));
  assert.ok(!yogaSlice.some(e => e.id === 'c_str'));
  assert.ok(!yogaSlice.some(e => e.id === 'c_plyo'));

  // Plyometrics includes only c_plyo
  const plyoSlice = librarySlice(S, [], ['plyometrics']);
  assert.ok(plyoSlice.some(e => e.id === 'c_plyo'));
  assert.ok(!plyoSlice.some(e => e.id === 'c_str'));
  assert.ok(!plyoSlice.some(e => e.id === 'c_yoga'));
});

test('librarySlice falls back safely on unknown modality or unmatched equipment', () => {
  // Unknown modality falls back to default strength pool
  const unknownModSlice = librarySlice({}, [], ['unsupported_modality']);
  assert.ok(unknownModSlice.length > 0);
  for (const ex of unknownModSlice) {
    assert.equal(exerciseCategory(ex), 'strength');
  }

  // Unmatched equipment falls back to modality pool
  const yogaUnmatchedEquip = librarySlice({}, ['fictional_equipment'], ['yoga']);
  assert.ok(yogaUnmatchedEquip.length > 0);
  for (const ex of yogaUnmatchedEquip) {
    assert.equal(exerciseCategory(ex), 'yoga');
  }
});

test('build integrates modality filtering and coachProfile modalities', () => {
  const S = {
    coach: {
      profile: {
        goal: 'mobility',
        equipment: ['body weight'],
        modalities: ['yoga']
      }
    }
  };

  const payload = build(S, 'user1', { kind: 'create' });
  assert.deepEqual(payload.coachProfile.modalities, ['yoga']);
  assert.ok(payload.library.length > 0);
  for (const ex of payload.library) {
    assert.equal(exerciseCategory(ex), 'yoga');
  }

  // Overriding modalities via opts
  const cardioPayload = build(S, 'user1', { kind: 'create', modalities: ['cardio'] });
  assert.ok(cardioPayload.library.length > 0);
  for (const ex of cardioPayload.library) {
    assert.equal(exerciseCategory(ex), 'cardio');
  }
});

test('build handles empty cardio history gracefully without NaN (Issue #69)', () => {
  const S = { cardioActivities: [] };
  const p = build(S, 'user1', { kind: 'review' });

  assert.ok(p.cardio, 'cardio object is present');
  assert.equal(p.cardio.summary7d.distanceKm, 0);
  assert.equal(p.cardio.summary7d.distanceMiles, 0);
  assert.equal(p.cardio.summary7d.mileage, 0);
  assert.equal(p.cardio.summary7d.durationMin, 0);
  assert.equal(p.cardio.summary7d.count, 0);

  assert.equal(p.cardio.summary28d.distanceKm, 0);
  assert.equal(p.cardio.summary28d.distanceMiles, 0);
  assert.equal(p.cardio.summary28d.mileage, 0);
  assert.equal(p.cardio.summary28d.durationMin, 0);
  assert.equal(p.cardio.summary28d.count, 0);

  assert.equal(p.cardio.acuteLoad, 0);
  assert.equal(p.cardio.chronicLoad, 0);
  assert.equal(p.cardio.acwr, 0);
  assert.equal(Number.isNaN(p.cardio.acwr), false);
  assert.equal(Number.isFinite(p.cardio.acwr), true);
  assert.equal(p.cardio.riskCategory, 'undertraining');

  assert.deepEqual(p.trainingLoad, {
    acuteLoad: 0,
    chronicLoad: 0,
    acwr: 0,
    riskCategory: 'undertraining',
    riskZone: 'undertraining'
  });

  // Verify review aggregates linkage
  assert.equal(p.aggregates.cardio, p.cardio);

  // Verify prompt serialization works without NaN or error
  const prompt = buildPrompt('review', p);
  assert.ok(prompt.includes('"acwr": 0'));
  assert.ok(prompt.includes('"riskCategory": "undertraining"'));
  assert.ok(!prompt.includes('NaN'));
});

test('build computes cardio volume summaries and ACWR training load from cardioActivities (Issue #69)', () => {
  const S = {
    cardioActivities: [
      // Within 7 days: 5000m = 5km, 30 min, RPE 7 -> load = 210
      { id: 'c1', d: '2026-11-10', startTime: '2026-11-10T08:00:00Z', durationMs: 1800000, distanceM: 5000, rpe: 7 },
      // Within 28 days (not 7d): 10000m = 10km, 60 min, RPE 8 -> load = 480
      { id: 'c2', d: '2026-11-03', startTime: '2026-11-03T10:00:00Z', durationMs: 3600000, distanceM: 10000, rpe: 8 }
    ]
  };

  const p = build(S, 'user1', { kind: 'review', today: '2026-11-12' });

  // 7-day summary: 5 km (3.11 mi), 30 min, 1 session
  assert.equal(p.cardio.summary7d.distanceKm, 5);
  assert.equal(p.cardio.summary7d.distanceMiles, 3.11);
  assert.equal(p.cardio.summary7d.durationMin, 30);
  assert.equal(p.cardio.summary7d.count, 1);

  // 28-day summary: 15 km (9.32 mi), 90 min, 2 sessions
  assert.equal(p.cardio.summary28d.distanceKm, 15);
  assert.equal(p.cardio.summary28d.distanceMiles, 9.32);
  assert.equal(p.cardio.summary28d.durationMin, 90);
  assert.equal(p.cardio.summary28d.count, 2);

  // Training load:
  // Acute total = 210 -> acuteDaily = 210 / 7 = 30
  // Chronic total = 690 -> chronicDaily = 690 / 28 = 24.64
  // ACWR = 30 / 24.64 = 1.22 (optimal: 0.8 - 1.3)
  assert.equal(p.cardio.acuteLoad, 30);
  assert.equal(p.cardio.chronicLoad, 24.6);
  assert.equal(p.cardio.acwr, 1.22);
  assert.equal(p.cardio.riskCategory, 'optimal');

  // Context in prompt
  const prompt = buildPrompt('review', p);
  assert.ok(prompt.includes('"acwr": 1.22'));
  assert.ok(prompt.includes('"riskCategory": "optimal"'));
  assert.ok(prompt.includes('"distanceKm": 5'));
  assert.ok(prompt.includes('"distanceKm": 15'));
});

test('acwrRiskCategory classifies risk zones and handles boundary conditions (Issue #69)', () => {
  assert.equal(acwrRiskCategory(0), 'undertraining');
  assert.equal(acwrRiskCategory(0.79), 'undertraining');
  assert.equal(acwrRiskCategory(0.8), 'optimal');
  assert.equal(acwrRiskCategory(1.0), 'optimal');
  assert.equal(acwrRiskCategory(1.3), 'optimal');
  assert.equal(acwrRiskCategory(1.31), 'caution');
  assert.equal(acwrRiskCategory(1.5), 'caution');
  assert.equal(acwrRiskCategory(1.51), 'danger');
  assert.equal(acwrRiskCategory(2.0), 'danger');
  assert.equal(acwrRiskCategory(NaN), 'undertraining');
  assert.equal(acwrRiskCategory(null), 'undertraining');
  assert.equal(acwrRiskCategory(undefined), 'undertraining');
  assert.equal(acwrRiskCategory(Infinity), 'undertraining');
});
