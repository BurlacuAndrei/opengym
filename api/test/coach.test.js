import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData, sampleState } from './helpers.mjs';

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
