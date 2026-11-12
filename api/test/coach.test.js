import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData, sampleState } from './helpers.mjs';
import { buildPrompt } from '../../shared/coach/prompts.js';

tempData();
const payload = await import('../coach/payload.js');

test('librarySlice default preserves strength behavior when modalities are omitted', () => {
  const allDefault = payload.librarySlice({}, []);
  assert.ok(allDefault.length > 0, 'has exercises');

  // Verify all returned exercises belong to strength
  for (const ex of allDefault) {
    const cat = ex.cat || ex.category || (ex.id?.startsWith('yoga-') ? 'yoga' : ex.bp === 'cardio' ? 'cardio' : 'strength');
    assert.equal(cat, 'strength');
  }

  // Equipment filtering on default strength behavior
  const dumbbells = payload.librarySlice({}, ['dumbbell']);
  assert.ok(dumbbells.length > 0 && dumbbells.length < allDefault.length);
});

test('librarySlice filters by explicit modality (yoga, stretching, plyometrics, cardio)', () => {
  // Yoga
  const yoga = payload.librarySlice({}, [], ['yoga']);
  assert.ok(yoga.length > 0, 'has yoga exercises');
  for (const ex of yoga) {
    const isYoga = ex.cat === 'yoga' || ex.id?.startsWith('yoga-');
    assert.ok(isYoga, `exercise ${ex.id} is yoga`);
  }

  // Stretching
  const stretching = payload.librarySlice({}, [], ['stretching']);
  assert.ok(stretching.length > 0, 'has stretching exercises');

  // Plyometrics
  const plyometrics = payload.librarySlice({}, [], ['plyometrics']);
  assert.ok(plyometrics.length > 0, 'has plyometrics exercises');

  // Cardio
  const cardio = payload.librarySlice({}, [], ['cardio']);
  assert.ok(cardio.length > 0, 'has cardio exercises');
  for (const ex of cardio) {
    const isCardio = ex.cat === 'cardio' || ex.bp === 'cardio';
    assert.ok(isCardio, `exercise ${ex.id} is cardio`);
  }
});

test('librarySlice keeps payload compact for active modalities', () => {
  const fullCount = payload.LIBRARY.length;
  const yogaSlice = payload.librarySlice({}, [], ['yoga']);
  const plyoSlice = payload.librarySlice({}, [], ['plyometrics']);

  // Modality slices should be a compact subset of the full library
  assert.ok(yogaSlice.length < fullCount, 'yoga slice is compact');
  assert.ok(plyoSlice.length < fullCount, 'plyo slice is compact');
  assert.ok(yogaSlice.length < 100, 'yoga library slice is well under 100 exercises');
});

test('librarySlice handles multi-modality combinations', () => {
  const yoga = payload.librarySlice({}, [], ['yoga']);
  const stretch = payload.librarySlice({}, [], ['stretching']);
  const combo = payload.librarySlice({}, [], ['yoga', 'stretching']);

  assert.equal(combo.length, yoga.length + stretch.length);
});

test('librarySlice filters custom exercises matching active modalities', () => {
  const S = sampleState({
    customEx: [
      { id: 'cx_str', n: 'Custom Sandbag', bp: 'back' }, // defaults to strength
      { id: 'cx_yoga', n: 'Custom Vinyasa', bp: 'back', cat: 'yoga' },
      { id: 'cx_plyo', n: 'Custom Box Jump', bp: 'legs', category: 'plyometrics' }
    ]
  });

  // Default strength includes only cx_str
  const strSlice = payload.librarySlice(S, []);
  assert.ok(strSlice.some(e => e.id === 'cx_str'));
  assert.ok(!strSlice.some(e => e.id === 'cx_yoga'));
  assert.ok(!strSlice.some(e => e.id === 'cx_plyo'));

  // Yoga modality includes cx_yoga
  const yogaSlice = payload.librarySlice(S, [], ['yoga']);
  assert.ok(yogaSlice.some(e => e.id === 'cx_yoga'));
  assert.ok(!yogaSlice.some(e => e.id === 'cx_str'));
  assert.ok(!yogaSlice.some(e => e.id === 'cx_plyo'));
});

test('librarySlice gracefully handles unknown modalities and unmatched equipment', () => {
  // Unknown modality falls back to default strength pool
  const fallback = payload.librarySlice({}, [], ['unknown_modality']);
  assert.ok(fallback.length > 0);

  // Unmatched equipment within a modality falls back to modality pool
  const unmatchedEquip = payload.librarySlice({}, ['space_station_harness'], ['yoga']);
  assert.ok(unmatchedEquip.length > 0);
  for (const ex of unmatchedEquip) {
    assert.ok(ex.cat === 'yoga' || ex.id?.startsWith('yoga-'));
  }
});

test('payload.build slices library based on requested intake modalities (Issue #49)', () => {
  const S = sampleState();
  const p = payload.build(S, 'u1', {
    kind: 'create',
    intake: {
      goal: 'mobility',
      equipment: ['body weight'],
      modalities: ['yoga']
    }
  });

  assert.equal(p.task, 'create');
  assert.deepEqual(p.coachProfile.modalities, ['yoga']);
  assert.ok(Array.isArray(p.library) && p.library.length > 0);
  for (const ex of p.library) {
    const isYoga = ex.cat === 'yoga' || ex.id?.startsWith('yoga-');
    assert.ok(isYoga, `exercise ${ex.id} matches yoga modality`);
  }
});

test('payload.build slices library based on coach profile modalities in review mode', () => {
  const S = sampleState();
  S.coach.profile = {
    goal: 'cardiovascular',
    equipment: [],
    modalities: ['cardio']
  };

  const p = payload.build(S, 'u1', { kind: 'review' });
  assert.equal(p.task, 'review');
  assert.deepEqual(p.coachProfile.modalities, ['cardio']);
  assert.ok(Array.isArray(p.library) && p.library.length > 0);
  for (const ex of p.library) {
    const isCardio = ex.cat === 'cardio' || ex.bp === 'cardio';
    assert.ok(isCardio, `exercise ${ex.id} matches cardio modality`);
  }
});

test('payload.build integrates cardio volume summaries and ACWR training load into coach payload and prompt (Issue #69)', () => {
  const S = sampleState({
    cardioActivities: [
      // Within last 7 days: 6000m = 6km (3.73mi), 30 min, RPE 7 -> load = 210
      { id: 'c1', d: '2026-11-10', startTime: '2026-11-10T07:30:00Z', durationMs: 1800000, distanceM: 6000, rpe: 7 },
      // Within last 28 days (prior to last 7d): 12000m = 12km (7.46mi), 60 min, RPE 8 -> load = 480
      { id: 'c2', d: '2026-11-02', startTime: '2026-11-02T09:00:00Z', durationMs: 3600000, distanceM: 12000, rpe: 8 }
    ]
  });

  const p = payload.build(S, 'u1', { kind: 'review', today: '2026-11-12' });

  // 7-day volume summary
  assert.equal(p.cardio.summary7d.distanceKm, 6);
  assert.equal(p.cardio.summary7d.distanceMiles, 3.73);
  assert.equal(p.cardio.summary7d.durationMin, 30);
  assert.equal(p.cardio.summary7d.count, 1);

  // 28-day volume summary
  assert.equal(p.cardio.summary28d.distanceKm, 18);
  assert.equal(p.cardio.summary28d.distanceMiles, 11.18);
  assert.equal(p.cardio.summary28d.durationMin, 90);
  assert.equal(p.cardio.summary28d.count, 2);

  // ACWR and Gabbett risk category
  // Acute: 210 / 7 = 30.0. Chronic: 690 / 28 = 24.64. ACWR: 30 / 24.64 = 1.22
  assert.equal(p.cardio.acuteLoad, 30);
  assert.equal(p.cardio.chronicLoad, 24.6);
  assert.equal(p.cardio.acwr, 1.22);
  assert.equal(p.cardio.riskCategory, 'optimal');
  assert.equal(p.aggregates.cardio, p.cardio);

  // Prompt integration
  const prompt = buildPrompt('review', p);
  assert.ok(prompt.includes('"acwr": 1.22'));
  assert.ok(prompt.includes('"riskCategory": "optimal"'));
  assert.ok(prompt.includes('"summary7d"'));
  assert.ok(prompt.includes('"summary28d"'));
});

test('payload.build handles missing or empty cardioActivities gracefully without NaN (Issue #69)', () => {
  const S1 = sampleState({ cardioActivities: [] });
  const p1 = payload.build(S1, 'u1', { kind: 'review' });
  assert.equal(p1.cardio.summary7d.distanceKm, 0);
  assert.equal(p1.cardio.summary7d.durationMin, 0);
  assert.equal(p1.cardio.acuteLoad, 0);
  assert.equal(p1.cardio.chronicLoad, 0);
  assert.equal(p1.cardio.acwr, 0);
  assert.equal(Number.isNaN(p1.cardio.acwr), false);
  assert.equal(p1.cardio.riskCategory, 'undertraining');

  const S2 = sampleState();
  delete S2.cardioActivities;
  const p2 = payload.build(S2, 'u1', { kind: 'create' });
  assert.equal(p2.cardio.summary28d.distanceKm, 0);
  assert.equal(p2.cardio.acwr, 0);
  assert.equal(Number.isNaN(p2.cardio.acwr), false);
  assert.equal(p2.cardio.riskCategory, 'undertraining');

  // Verify prompt serializes cleanly without NaN
  const prompt = buildPrompt('create', p2);
  assert.ok(!prompt.includes('NaN'));
  assert.ok(prompt.includes('"riskCategory": "undertraining"'));
});
