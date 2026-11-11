import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getSessions,
  getFirstSession,
  normalizeSchedule,
  getDaySessions,
  getWeekSessions,
  canonicalPlan,
  hashPlan,
  planHash,
  mergePlan
} from './plan.js';

const SAMPLE_PLAN = {
  routines: [
    {
      id: 'r1',
      name: 'Upper Body',
      prog: 'linear',
      ex: [{ id: '0001', sets: 3, reps: 10, mode: 'reps' }]
    },
    {
      id: 'r2',
      name: 'Lower Body',
      prog: 'linear',
      ex: [{ id: '0007', sets: 4, reps: 8, mode: 'reps' }]
    },
    {
      id: 'r3',
      name: 'Cardio Core',
      prog: '',
      ex: [{ id: '0015', sets: 3, min: 20, mode: 'cardio' }]
    }
  ],
  week: { 1: 'r1', 3: 'r2' }
};

test('getSessions handles string, array, and falsy legacy values', () => {
  assert.deepEqual(getSessions('r1'), ['r1']);
  assert.deepEqual(getSessions(['r1']), ['r1']);
  assert.deepEqual(getSessions(['r1', 'r2']), ['r1', 'r2']);
  assert.deepEqual(getSessions(''), []);
  assert.deepEqual(getSessions(null), []);
  assert.deepEqual(getSessions(undefined), []);
  assert.deepEqual(getSessions([]), []);
  assert.deepEqual(getSessions(['r1', '', '  ', null, 'r2']), ['r1', 'r2']);
});

test('getFirstSession returns the first session or null transparently', () => {
  assert.equal(getFirstSession('r1'), 'r1');
  assert.equal(getFirstSession(['r1', 'r2']), 'r1');
  assert.equal(getFirstSession([]), null);
  assert.equal(getFirstSession(null), null);
  assert.equal(getFirstSession(''), null);
});

test('normalizeSchedule normalizes legacy string mapping to session arrays', () => {
  const legacy = {
    1: 'r1',
    3: ['r2', 'r3'],
    5: '',
    6: null
  };
  const normalized = normalizeSchedule(legacy);
  assert.deepEqual(normalized, {
    1: ['r1'],
    3: ['r2', 'r3']
  });
});

test('getDaySessions and getWeekSessions extract sessions from both shapes', () => {
  const state = {
    week: { 1: 'r1', 4: ['r2', 'r3'] },
    dayPlan: {
      '2026-11-12': 'r1',
      '2026-11-13': ['r2', 'r3'],
      '2026-11-14': 'rest'
    }
  };

  assert.deepEqual(getWeekSessions(state, 1), ['r1']);
  assert.deepEqual(getWeekSessions(state, 4), ['r2', 'r3']);
  assert.deepEqual(getWeekSessions(state, 0), []);

  assert.deepEqual(getDaySessions(state, '2026-11-12'), ['r1']);
  assert.deepEqual(getDaySessions(state, '2026-11-13'), ['r2', 'r3']);
  assert.deepEqual(getDaySessions(state, '2026-11-14'), ['rest']);
  assert.deepEqual(getDaySessions(state, '2026-11-20'), []);
});

test('canonicalPlan normalizes legacy string week to session arrays and supports multi-session days', () => {
  const legacyState = {
    routines: SAMPLE_PLAN.routines,
    week: { 1: 'r1', 3: 'r2' }
  };
  const multiState = {
    routines: SAMPLE_PLAN.routines,
    week: { 1: ['r1', 'r3'], 3: ['r2'] }
  };

  const canonLegacy = canonicalPlan(legacyState);
  assert.deepEqual(canonLegacy.week, {
    1: ['r1'],
    3: ['r2']
  });

  const canonMulti = canonicalPlan(multiState);
  assert.deepEqual(canonMulti.week, {
    1: ['r1', 'r3'],
    3: ['r2']
  });
});

test('hashPlan produces identical hash for legacy string and single-element session array', () => {
  const legacyPlan = {
    routines: SAMPLE_PLAN.routines,
    week: { 1: 'r1', 3: 'r2' }
  };
  const arrayPlan = {
    routines: SAMPLE_PLAN.routines,
    week: { 1: ['r1'], 3: ['r2'] }
  };

  const legacyCanon = canonicalPlan(legacyPlan);
  const arrayCanon = canonicalPlan(arrayPlan);

  assert.equal(hashPlan(legacyCanon), hashPlan(arrayCanon));
  assert.equal(planHash(legacyPlan), planHash(arrayPlan));
});

test('hashPlan distinguishes multi-session days deterministically', () => {
  const single = {
    routines: SAMPLE_PLAN.routines,
    week: { 1: ['r1'] }
  };
  const multi = {
    routines: SAMPLE_PLAN.routines,
    week: { 1: ['r1', 'r2'] }
  };

  assert.notEqual(planHash(single), planHash(multi));
  assert.equal(planHash(multi), planHash(multi));
});

test('mergePlan handles single session string and multi-session array updates', () => {
  const plan = JSON.parse(JSON.stringify(SAMPLE_PLAN));

  // Merge single string week change
  mergePlan(plan, {
    changes: [
      {
        id: 'c1',
        type: 'week',
        target: { weekday: 5 },
        why: 'Add Friday session',
        after: 'r3'
      }
    ]
  });
  assert.deepEqual(plan.week[5], ['r3']);

  // Merge multi-session array week change
  mergePlan(plan, {
    changes: [
      {
        id: 'c2',
        type: 'week',
        target: { weekday: 1 },
        why: 'Split into two sessions on Monday',
        after: ['r1', 'r3']
      }
    ]
  });
  assert.deepEqual(plan.week[1], ['r1', 'r3']);

  // Setting rest clears day
  mergePlan(plan, {
    changes: [
      {
        id: 'c3',
        type: 'week',
        target: { weekday: 5 },
        why: 'Rest Friday',
        after: 'rest'
      }
    ]
  });
  assert.equal(plan.week[5], undefined);
});

test('mergePlan removes routine from multi-session day while preserving other sessions', () => {
  const plan = {
    routines: [
      { id: 'r1', name: 'A', ex: [] },
      { id: 'r2', name: 'B', ex: [] }
    ],
    week: {
      1: ['r1', 'r2'],
      3: ['r1']
    }
  };

  mergePlan(plan, {
    changes: [
      {
        id: 'c1',
        type: 'remove-routine',
        target: { routineId: 'r1' },
        why: 'Drop routine r1'
      }
    ]
  });

  // Monday should keep r2
  assert.deepEqual(plan.week[1], ['r2']);
  // Wednesday had only r1, so it should be completely removed
  assert.equal(plan.week[3], undefined);
  // Routines array should only have r2
  assert.deepEqual(plan.routines.map(r => r.id), ['r2']);
});
