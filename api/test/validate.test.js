import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const { extractJSON, validatePlan, validateReview, CHANGE_TYPES } = await import('../../shared/coach/validate.js');

const PLAN = {
  routines: [{
    id: 'r1', name: 'Full body A',
    ex: [{ id: '0001', sets: 3, reps: 10 }, { id: '0007', sets: 3, sec: 45 }]
  }, { id: 'r2', name: 'Full body B', ex: [{ id: '0009', sets: 3, reps: 8 }] }],
  week: { 1: 'r1', 3: 'r2' }
};
const change = over => ({ id: 'c1', type: 'sets', target: { routineId: 'r1', exId: '0001' }, before: 3, after: 4, why: 'stalled twice', ...over });
const review = changes => validateReview({ coach_contract: 1, summary: 's', changes }, PLAN);

/* ---------------- extraction ---------------- */

test('JSON is recovered from whatever the model wrapped it in', () => {
  assert.deepEqual(extractJSON('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJSON('```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepEqual(extractJSON('Here you go:\n```\n{"a":1}\n```\nHope that helps!').value, { a: 1 });
  assert.deepEqual(extractJSON('Sure. {"a":1} — let me know.').value, { a: 1 });
  assert.ok(extractJSON('I cannot help with that.').error);
  assert.ok(extractJSON('').error);
});

/* ---------------- created plans ---------------- */

test('a plan referencing an unknown exercise is rejected, not quietly trimmed', () => {
  const r = validatePlan({
    routines: [{ name: 'A', ex: [{ id: '0001', sets: 3, reps: 10 }, { id: 'not-a-real-id', sets: 3, reps: 10 }] }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('not-a-real-id')));
});

test('a plan may reference a custom exercise it defines in the same answer', () => {
  const r = validatePlan({
    routines: [{ name: 'A', ex: [{ id: 'cx1', sets: 3, reps: 10 }] }],
    customEx: [{ id: 'cx1', n: 'Sandbag carry', bp: 'back' }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.bundle.customEx[0].n, 'Sandbag carry');
});

test('the week may only point at routines the plan actually defines', () => {
  const r = validatePlan({ routines: [{ id: 'r1', name: 'A', ex: [{ id: '0001', sets: 3, reps: 10 }] }], week: { 1: 'ghost' } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('ghost')));
});

test('proposed baselines are capped at what the lifter has actually handled', () => {
  const r = validatePlan(
    { routines: [{ id: 'r1', name: 'A', ex: [{ id: '0001', sets: 3, reps: 10, weight: 100 }] }] },
    { workingWeights: [{ id: '0001', best: 40 }] }
  );
  assert.equal(r.ok, true);
  assert.equal(r.bundle.routines[0].ex[0].weight, 40, 'optimism is clamped to evidence');
});

test('a plan that ignores the requested number of training days is rejected', () => {
  const r = validatePlan(
    { routines: [{ id: 'r1', name: 'A', ex: [{ id: '0001', sets: 3, reps: 10 }] }], week: { 1: 'r1', 2: 'r1', 3: 'r1', 4: 'r1' } },
    { daysPerWeek: 3 }
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('4 days') && e.includes('3')));
});

test('an unknown progression policy is rejected', () => {
  const r = validatePlan({ routines: [{ name: 'A', prog: 'vibes', ex: [{ id: '0001', sets: 3, reps: 10 }] }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('vibes')));
});

/* ---------------- review change-sets ---------------- */

test('an invented change type does nothing at all', () => {
  const r = review([change({ type: 'delete-all-workouts' })]);
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('not allowed'));
  assert.ok(!CHANGE_TYPES.includes('delete-all-workouts'));
});

test('every change must target something that exists', () => {
  assert.equal(review([change({ target: { routineId: 'ghost', exId: '0001' } })]).ok, false);
  assert.equal(review([change({ target: { routineId: 'r1', exId: '9999' } })]).ok, false, 'exercise not in that routine');
  assert.equal(review([change({ target: { routineId: 'r2', exId: '0001' } })]).ok, false, 'right exercise, wrong routine');
});

test('a change without a rationale is rejected', () => {
  const r = review([change({ why: '' })]);
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('why'));
});

test('values are type-checked per change type', () => {
  assert.equal(review([change({ type: 'sets', after: 'four' })]).ok, false);
  assert.equal(review([change({ type: 'sets', after: 99 })]).ok, false);
  assert.equal(review([change({ type: 'reps', after: 0 })]).ok, false);
  assert.equal(review([change({ type: 'exercise-prog', after: 'linear' })]).ok, true);
  assert.equal(review([change({ type: 'exercise-prog', after: 'vibes' })]).ok, false);
  assert.equal(review([change({ type: 'inc', after: -5 })]).ok, false);
});

test('adding an exercise requires a real library id', () => {
  const ok = review([change({ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: '0009', sets: 3, reps: 12 } })]);
  assert.equal(ok.ok, true);
  assert.equal(ok.proposal.changes[0].after.name, 'assisted chest dip (kneeling)');
  assert.equal(review([change({ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: 'made-up' } })]).ok, false);
});

test('a reorder must be a permutation of what is already there', () => {
  assert.equal(review([change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0007', '0001'] })]).ok, true);
  assert.equal(review([change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0007'] })]).ok, false, 'dropping one is not a reorder');
  assert.equal(review([change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0007', '0009'] })]).ok, false, 'nor is smuggling one in');
});

test('a week change may only schedule a routine that exists, rest, or nothing', () => {
  assert.equal(review([change({ type: 'week', target: { weekday: 6 }, after: 'r2' })]).ok, true);
  assert.equal(review([change({ type: 'week', target: { weekday: 6 }, after: 'rest' })]).ok, true);
  assert.equal(review([change({ type: 'week', target: { weekday: 6 }, after: null })]).ok, true);
  assert.equal(review([change({ type: 'week', target: { weekday: 9 }, after: 'r1' })]).ok, false);
  assert.equal(review([change({ type: 'week', target: { weekday: 6 }, after: 'ghost' })]).ok, false);
});

test('"nothing to change" is a first-class answer, and so is an empty change list', () => {
  const a = validateReview({ nochange: true, reading: 'Plan is working.' }, PLAN);
  assert.equal(a.nochange, true);
  assert.equal(a.reading, 'Plan is working.');
  const b = review([]);
  assert.equal(b.nochange, true, 'no changes and "no changes" are the same outcome');
});

test('advice-only notes survive but carry no change', () => {
  const r = validateReview({ summary: 's', changes: [change()], notes: ['Body weight is flat — eat more.'] }, PLAN);
  assert.equal(r.proposal.notes.length, 1);
  assert.equal(r.proposal.changes.length, 1);
});

test('one bad change fails the whole set — nothing is ever half-applied', () => {
  const r = review([change(), change({ id: 'c2', type: 'not-a-type' })]);
  assert.equal(r.ok, false);
});

test('every allowed change type has a validator that accepts a well-formed instance', () => {
  const good = {
    'add-exercise': change({ type: 'add-exercise', target: { routineId: 'r1' }, after: { id: '0009', sets: 3, reps: 10 } }),
    'remove-exercise': change({ type: 'remove-exercise' }),
    'swap-exercise': change({ type: 'swap-exercise', after: { id: '0009' } }),
    sets: change({ type: 'sets', after: 4 }),
    reps: change({ type: 'reps', after: 12 }),
    repsMin: change({ type: 'repsMin', after: 8 }),
    sec: change({ type: 'sec', target: { routineId: 'r1', exId: '0007' }, after: 60 }),
    cardio: change({ type: 'cardio', after: { min: 25, speed: 9 } }),
    reorder: change({ type: 'reorder', target: { routineId: 'r1' }, after: ['0007', '0001'] }),
    superset: change({ type: 'superset', after: { link: true, with: '0007' } }),
    'routine-prog': change({ type: 'routine-prog', target: { routineId: 'r1' }, after: 'double' }),
    'exercise-prog': change({ type: 'exercise-prog', after: 'greyskull' }),
    inc: change({ type: 'inc', after: 2.5 }),
    'add-routine': change({ type: 'add-routine', target: {}, after: { name: 'C', ex: [{ id: '0001', sets: 3, reps: 10 }] } }),
    'remove-routine': change({ type: 'remove-routine', target: { routineId: 'r2' } }),
    'rename-routine': change({ type: 'rename-routine', target: { routineId: 'r1' }, after: 'Upper' }),
    week: change({ type: 'week', target: { weekday: 2 }, after: 'r1' })
  };
  for (const type of CHANGE_TYPES) {
    assert.ok(good[type], `no fixture for change type "${type}" — add one`);
    const r = review([good[type]]);
    assert.equal(r.ok, true, `${type} should validate: ${JSON.stringify(r.errors)}`);
  }
});

test('shared coach exports validation interfaces matching server validate', async () => {
  const shared = await import('shared/coach');
  assert.deepEqual(CHANGE_TYPES, shared.CHANGE_TYPES);
  assert.equal(validatePlan, shared.validatePlan);
  assert.equal(validateReview, shared.validateReview);
  assert.equal(extractJSON, shared.extractJSON);
});

test('review validation allows custom exercises matching cust_ prefix or customEx option (Issue #50)', async () => {
  const withCustPrefix = review([
    change({
      type: 'add-exercise',
      target: { routineId: 'r1' },
      after: { id: 'cust_hex_press', name: 'Hex Press', sets: 3, reps: 10 }
    })
  ]);
  assert.equal(withCustPrefix.ok, true, `cust_ prefix should validate: ${JSON.stringify(withCustPrefix.errors)}`);
  assert.equal(withCustPrefix.proposal.changes[0].after.name, 'Hex Press');

  const withSwapCust = review([
    change({
      type: 'swap-exercise',
      target: { routineId: 'r1', exId: '0001' },
      after: { id: 'cust_incline_fly', name: 'Incline Fly', sets: 3, reps: 12 }
    })
  ]);
  assert.equal(withSwapCust.ok, true, `cust_ swap should validate: ${JSON.stringify(withSwapCust.errors)}`);

  const customExOption = [{ id: 'cx_custom1', n: 'Custom Sandbag Carry', bp: 'back' }];
  const withCustomEx = validateReview(
    {
      coach_contract: 1,
      summary: 'Add custom carry',
      changes: [
        change({
          type: 'add-exercise',
          target: { routineId: 'r1' },
          after: { id: 'cx_custom1', sets: 3, reps: 10 }
        })
      ]
    },
    PLAN,
    { customEx: customExOption }
  );
  assert.equal(withCustomEx.ok, true, `customEx option should validate: ${JSON.stringify(withCustomEx.errors)}`);
  assert.equal(withCustomEx.proposal.changes[0].after.name, 'Custom Sandbag Carry');

  const invalidEx = review([
    change({
      type: 'add-exercise',
      target: { routineId: 'r1' },
      after: { id: 'invalid_non_custom_id' }
    })
  ]);
  assert.equal(invalidEx.ok, false, 'Invalid non-custom ID must be rejected');
});

test('mergePlan treats customEx as first-class exercises across review change operations (Issue #50)', async () => {
  const { mergePlan, canonicalPlan, planHash } = await import('shared/coach');

  const plan = JSON.parse(JSON.stringify(PLAN));
  const reviewChanges = [
    change({
      type: 'add-exercise',
      target: { routineId: 'r1' },
      after: { id: 'cust_band_pull', name: 'Band Pull-Apart', sets: 3, reps: 15 }
    }),
    change({
      type: 'swap-exercise',
      target: { routineId: 'r1', exId: '0007' },
      after: { id: 'cust_safety_squat', name: 'Safety Bar Squat', sets: 4, reps: 6 }
    })
  ];

  const merged = mergePlan(plan, { changes: reviewChanges }, {
    customEx: [{ id: 'cust_safety_squat', n: 'Safety Bar Squat', bp: 'legs' }]
  });

  const r1 = merged.routines.find(r => r.id === 'r1');
  assert.ok(r1.ex.some(e => e.id === 'cust_band_pull'), 'Added custom exercise must be present');
  assert.ok(r1.ex.some(e => e.id === 'cust_safety_squat'), 'Swapped custom exercise must be present');
  assert.equal(r1.ex.some(e => e.id === '0007'), false, 'Replaced exercise must be absent');

  assert.ok(merged.customEx.some(c => c.id === 'cust_band_pull'), 'cust_band_pull registered in plan.customEx');
  assert.ok(merged.customEx.some(c => c.id === 'cust_safety_squat'), 'cust_safety_squat registered in plan.customEx');

  const canon = canonicalPlan(merged);
  assert.ok(canon);
  const hash = planHash(merged);
  assert.equal(typeof hash, 'string');
});

/* =============================== Coach cardio toggle & validation (Issue #77) =============================== */

test('validatePlan rejects cardio sessions in week when includeCardio is false or omitted (Issue #77)', () => {
  const planData = {
    routines: [{ id: 'r1', name: 'Upper', ex: [{ id: '0001', sets: 3, reps: 10 }] }],
    week: { 1: 'r1', 3: { kind: 'cardio', type: 'run', duration: 30 } }
  };

  // Omitted
  const r1 = validatePlan(planData);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some(e => e.includes('Cardio sessions are disabled in coach profile')));

  // Explicit false
  const r2 = validatePlan(planData, { coachProfile: { includeCardio: false } });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some(e => e.includes('Cardio sessions are disabled in coach profile')));
});

test('validatePlan accepts cardio sessions when includeCardio is true and respects profile bounds (Issue #77)', () => {
  const r = validatePlan(
    {
      routines: [
        { id: 'r1', name: 'Full Body', ex: [{ id: '0001', sets: 3, reps: 10 }] }
      ],
      week: {
        1: 'r1',
        2: {
          kind: 'cardio',
          type: 'run',
          duration: 30,
          steps: [
            { kind: 'warmup', durSec: 300 },
            { kind: 'work', distM: 3000 },
            { kind: 'cooldown', durSec: 300 }
          ]
        }
      }
    },
    {
      coachProfile: {
        includeCardio: true,
        daysPerWeek: 1,
        cardioSessionsPerWeek: 2,
        cardioTypes: ['run', 'walk'],
        cardioGoal: 'Aerobic base'
      }
    }
  );
  assert.equal(r.ok, true, `Validation should succeed: ${JSON.stringify(r.errors)}`);
  assert.equal(r.bundle.week[2].kind, 'cardio');
  assert.equal(r.bundle.week[2].type, 'run');
  assert.equal(r.bundle.week[2].steps.length, 3);
});

test('validatePlan rejects cardio when count exceeds cardioSessionsPerWeek (Issue #77)', () => {
  const r = validatePlan(
    {
      routines: [{ id: 'r1', name: 'A', ex: [{ id: '0001', sets: 3, reps: 10 }] }],
      week: {
        1: 'r1',
        2: { kind: 'cardio', type: 'run', duration: 25 },
        4: { kind: 'cardio', type: 'ride', duration: 40 }
      }
    },
    {
      coachProfile: {
        includeCardio: true,
        daysPerWeek: 1,
        cardioSessionsPerWeek: 1
      }
    }
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('2 cardio sessions which exceeds cardioSessionsPerWeek of 1')));
});

test('validateReview enforces includeCardio and interval steps (Issue #77)', () => {
  // Rejected when includeCardio is false or omitted
  const rDisabled = review([
    change({
      type: 'week',
      target: { weekday: 2 },
      after: { kind: 'cardio', type: 'run', duration: 30 }
    })
  ]);
  assert.equal(rDisabled.ok, false);
  assert.ok(rDisabled.errors.some(e => e.includes('Cardio sessions are disabled in coach profile')));

  // Accepted when includeCardio is true
  const rEnabled = validateReview(
    {
      coach_contract: 1,
      summary: 'Add easy cardio',
      changes: [
        change({
          type: 'week',
          target: { weekday: 2 },
          after: {
            kind: 'cardio',
            type: 'walk',
            duration: 45,
            steps: [{ kind: 'work', durSec: 2700 }]
          }
        })
      ]
    },
    PLAN,
    { coachProfile: { includeCardio: true, cardioSessionsPerWeek: 2 } }
  );
  assert.equal(rEnabled.ok, true, `Review should validate: ${JSON.stringify(rEnabled.errors)}`);
  assert.equal(rEnabled.proposal.changes[0].after.kind, 'cardio');
  assert.equal(rEnabled.proposal.changes[0].after.type, 'walk');
});

test('validatePlan and validateReview enforce per-modality switches and proposal application (Issue #81)', async () => {
  const { mergePlan } = await import('../../shared/coach/plan.js');

  // 1. validatePlan rejects when modality is disabled
  const planHiit = {
    routines: [
      { id: 'r1', name: 'Sprint Day', kind: 'hiit', restSec: 30, ex: [{ id: '0001', sets: 4, reps: 15 }] }
    ],
    week: { 1: 'r1' }
  };
  const resBadPlan = validatePlan(planHiit, {
    coachProfile: { modalities: { gym: true, cardio: false, hiit: false, yoga: true, mobility: false } }
  });
  assert.equal(resBadPlan.ok, false);
  assert.ok(resBadPlan.errors.some(e => e.includes('Hiit routines are disabled in coach profile')));

  // 2. validatePlan accepts enabled hiit, yoga, mobility with restSec and customEx
  const planMulti = {
    name: 'Multi Modality Block',
    summary: 'Gym, HIIT, and Yoga in one weekly plan.',
    routines: [
      { id: 'r1', name: 'Heavy Upper', kind: 'gym', restSec: 90, ex: [{ id: '0001', sets: 3, reps: 8 }] },
      { id: 'r2', name: 'Tabata', kind: 'hiit', restSec: 20, ex: [{ id: 'cx_hiit', sets: 4, reps: 12 }] },
      { id: 'r3', name: 'Recovery Yoga', kind: 'yoga', restSec: 0, ex: [{ id: '0007', sets: 2, sec: 60, mode: 'time' }] }
    ],
    customEx: [{ id: 'cx_hiit', n: 'Jump Tuck', bp: 'legs', desc: 'Explosive tuck jumps' }],
    week: { 1: 'r1', 3: 'r2', 5: 'r3' }
  };
  const resGoodPlan = validatePlan(planMulti, {
    coachProfile: {
      modalities: { gym: true, cardio: false, hiit: true, yoga: true, mobility: false },
      sessionsPerWeek: { gym: 1, hiit: 1, yoga: 1 }
    }
  });
  assert.equal(resGoodPlan.ok, true, `Should validate: ${JSON.stringify(resGoodPlan.errors)}`);
  assert.equal(resGoodPlan.bundle.routines[1].kind, 'hiit');
  assert.equal(resGoodPlan.bundle.routines[1].restSec, 20);
  assert.equal(resGoodPlan.bundle.routines[2].kind, 'yoga');
  assert.equal(resGoodPlan.bundle.routines[2].restSec, 0);

  // 3. Target sessionsPerWeek count mismatch
  const resMismatch = validatePlan(planMulti, {
    coachProfile: {
      modalities: { gym: true, cardio: false, hiit: true, yoga: true, mobility: false },
      sessionsPerWeek: { gym: 2, hiit: 1, yoga: 1 } // asked for 2 gym, got 1
    }
  });
  assert.equal(resMismatch.ok, false);
  assert.ok(resMismatch.errors.some(e => e.includes('1 days but 2 were asked for')));

  // 4. validateReview rejects disabled modality in add-routine
  const reviewAddHiit = {
    coach_contract: 1,
    summary: 'Add hiit routine',
    changes: [
      {
        id: 'c1',
        type: 'add-routine',
        why: 'Conditioning booster',
        after: {
          id: 'r_hiit',
          name: 'HIIT Circuit',
          kind: 'hiit',
          restSec: 25,
          ex: [{ id: '0001', sets: 3, reps: 15 }]
        }
      }
    ]
  };
  const resBadReview = validateReview(reviewAddHiit, PLAN, {
    coachProfile: { modalities: { gym: true, cardio: false, hiit: false, yoga: true, mobility: false } }
  });
  assert.equal(resBadReview.ok, false);
  assert.ok(resBadReview.errors.some(e => e.includes('Hiit routines are disabled in coach profile')));

  // 5. validateReview accepts enabled modality and applies with mergePlan
  const resGoodReview = validateReview(reviewAddHiit, PLAN, {
    coachProfile: { modalities: { gym: true, cardio: false, hiit: true, yoga: true, mobility: false } }
  });
  assert.equal(resGoodReview.ok, true, `Should validate: ${JSON.stringify(resGoodReview.errors)}`);
  assert.equal(resGoodReview.proposal.changes[0].after.kind, 'hiit');
  assert.equal(resGoodReview.proposal.changes[0].after.restSec, 25);

  const applied = mergePlan(structuredClone(PLAN), resGoodReview.proposal);
  const added = applied.routines.find(r => r.name === 'HIIT Circuit');
  assert.ok(added);
  assert.equal(added.kind, 'hiit');
  assert.equal(added.restSec, 25);
});
