import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReview, validatePlan, CHANGE_TYPES } from './validate.js';
import { mergePlan, canonicalPlan, planHash } from './plan.js';

const BASE_PLAN = {
  routines: [
    {
      id: 'r1',
      name: 'Upper Body',
      emoji: '💪',
      prog: 'linear',
      ex: [
        { id: '0001', sets: 3, reps: 10, mode: 'reps' },
        { id: '0007', sets: 3, reps: 8, mode: 'reps' }
      ]
    },
    {
      id: 'r2',
      name: 'Lower Body',
      emoji: '🦵',
      prog: 'linear',
      ex: [
        { id: '0015', sets: 4, reps: 6, mode: 'reps' }
      ]
    }
  ],
  week: { 1: 'r1', 3: 'r2' },
  customEx: [
    { id: 'cx_existing', n: 'Farmer Carry', bp: 'forearms', desc: 'Heavy carry' }
  ]
};

const makeReview = changes => ({
  coach_contract: 1,
  summary: 'Review proposal for plan updates',
  changes
});

test('validateReview accepts custom exercises with cust_ prefix in add-exercise', () => {
  const proposal = makeReview([
    {
      id: 'c1',
      type: 'add-exercise',
      target: { routineId: 'r1' },
      why: 'Add chest fly variant for accessory volume',
      after: { id: 'cust_cable_fly', name: 'Cable Fly', sets: 3, reps: 12 }
    }
  ]);

  const res = validateReview(proposal, BASE_PLAN);
  assert.equal(res.ok, true, `Should validate: ${JSON.stringify(res.errors)}`);
  assert.equal(res.proposal.changes[0].after.id, 'cust_cable_fly');
  assert.equal(res.proposal.changes[0].after.name, 'Cable Fly');
});

test('validateReview accepts custom exercises from options.customEx', () => {
  const proposal = makeReview([
    {
      id: 'c1',
      type: 'add-exercise',
      target: { routineId: 'r1' },
      why: 'Add sandbag carry for conditioning',
      after: { id: 'cx_sandbag', sets: 3, reps: 10 }
    }
  ]);

  const customEx = [{ id: 'cx_sandbag', n: 'Sandbag Carry', bp: 'back' }];
  const res = validateReview(proposal, BASE_PLAN, { customEx });
  assert.equal(res.ok, true, `Should validate: ${JSON.stringify(res.errors)}`);
  assert.equal(res.proposal.changes[0].after.id, 'cx_sandbag');
  assert.equal(res.proposal.changes[0].after.name, 'Sandbag Carry');
});

test('validateReview accepts custom exercises from plan.customEx', () => {
  const proposal = makeReview([
    {
      id: 'c1',
      type: 'add-exercise',
      target: { routineId: 'r1' },
      why: 'Add existing custom exercise to routine',
      after: { id: 'cx_existing', sets: 3, reps: 10 }
    }
  ]);

  const res = validateReview(proposal, BASE_PLAN);
  assert.equal(res.ok, true, `Should validate: ${JSON.stringify(res.errors)}`);
  assert.equal(res.proposal.changes[0].after.id, 'cx_existing');
  assert.equal(res.proposal.changes[0].after.name, 'Farmer Carry');
});

test('validateReview accepts custom exercises in swap-exercise', () => {
  const proposal = makeReview([
    {
      id: 'c1',
      type: 'swap-exercise',
      target: { routineId: 'r1', exId: '0001' },
      why: 'Swap out bench press for custom incline press',
      after: { id: 'cust_incline_smith', name: 'Incline Smith Press', sets: 3, reps: 8 }
    }
  ]);

  const res = validateReview(proposal, BASE_PLAN);
  assert.equal(res.ok, true, `Should validate: ${JSON.stringify(res.errors)}`);
  assert.equal(res.proposal.changes[0].after.id, 'cust_incline_smith');
  assert.equal(res.proposal.changes[0].after.name, 'Incline Smith Press');
});

test('validateReview accepts custom exercises in add-routine', () => {
  const proposal = makeReview([
    {
      id: 'c1',
      type: 'add-routine',
      why: 'Add full body custom routine',
      after: {
        name: 'Custom Day',
        emoji: '🔥',
        ex: [
          { id: 'cust_special_deadlift', name: 'Deficit Deadlift', sets: 3, reps: 5 },
          { id: 'cx_existing', sets: 3, reps: 10 }
        ]
      }
    }
  ]);

  const res = validateReview(proposal, BASE_PLAN);
  assert.equal(res.ok, true, `Should validate: ${JSON.stringify(res.errors)}`);
  assert.equal(res.proposal.changes[0].after.ex.length, 2);
  assert.equal(res.proposal.changes[0].after.ex[0].id, 'cust_special_deadlift');
  assert.equal(res.proposal.changes[0].after.ex[1].id, 'cx_existing');
});

test('validateReview accepts exercises from options.library slice', () => {
  const customLib = [
    { id: 'lib_extra_curl', n: 'Spider Curl', bp: 'arms' }
  ];
  const proposal = makeReview([
    {
      id: 'c1',
      type: 'add-exercise',
      target: { routineId: 'r1' },
      why: 'Add isolation movement from provided equipment library slice',
      after: { id: 'lib_extra_curl', sets: 3, reps: 12 }
    }
  ]);

  const res = validateReview(proposal, BASE_PLAN, { library: customLib });
  assert.equal(res.ok, true, `Should validate: ${JSON.stringify(res.errors)}`);
  assert.equal(res.proposal.changes[0].after.id, 'lib_extra_curl');
  assert.equal(res.proposal.changes[0].after.name, 'Spider Curl');
});

test('validateReview surgically rejects unknown exercise IDs', () => {
  const proposal = makeReview([
    {
      id: 'c1',
      type: 'add-exercise',
      target: { routineId: 'r1' },
      why: 'Unknown exercise should fail',
      after: { id: 'completely_unrecognized_exercise_id' }
    }
  ]);

  const res = validateReview(proposal, BASE_PLAN);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /must be an exercise id from the library/);
});

test('mergePlan adds custom exercise and registers customEx metadata', () => {
  const plan = JSON.parse(JSON.stringify(BASE_PLAN));
  const review = makeReview([
    {
      id: 'c1',
      type: 'add-exercise',
      target: { routineId: 'r1' },
      why: 'Add custom DB variation',
      after: { id: 'cust_db_snatch', name: 'Dumbbell Snatch', sets: 3, reps: 10 }
    }
  ]);

  const merged = mergePlan(plan, review, {
    customEx: [{ id: 'cust_db_snatch', n: 'Dumbbell Snatch', bp: 'shoulders' }]
  });

  const r1 = merged.routines.find(r => r.id === 'r1');
  const added = r1.ex.find(e => e.id === 'cust_db_snatch');
  assert.ok(added, 'Added custom exercise should be in routine');
  assert.equal(added.sets, 3);
  assert.equal(added.reps, 10);

  const customReg = merged.customEx.find(c => c.id === 'cust_db_snatch');
  assert.ok(customReg, 'Custom exercise should be registered in plan.customEx');
  assert.equal(customReg.n, 'Dumbbell Snatch');

  // Verify planHash and canonicalPlan work with merged custom exercise
  const canon = canonicalPlan(merged);
  assert.ok(canon);
  const hash = planHash(merged);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 16);
});

test('mergePlan supports replace (swap-exercise) with custom exercise', () => {
  const plan = JSON.parse(JSON.stringify(BASE_PLAN));
  const review = makeReview([
    {
      id: 'c1',
      type: 'swap-exercise',
      target: { routineId: 'r1', exId: '0001' },
      why: 'Replace flat bench with custom floor press',
      after: { id: 'cust_floor_press', name: 'Dumbbell Floor Press', sets: 4, reps: 8 }
    }
  ]);

  const merged = mergePlan(plan, review);
  const r1 = merged.routines.find(r => r.id === 'r1');
  assert.equal(r1.ex.some(e => e.id === '0001'), false, 'Old exercise should be replaced');
  const swapped = r1.ex.find(e => e.id === 'cust_floor_press');
  assert.ok(swapped, 'New custom exercise should exist');
  assert.equal(swapped.sets, 4);
  assert.equal(swapped.reps, 8);
});

test('mergePlan handles remove-exercise and routine modifications', () => {
  const plan = JSON.parse(JSON.stringify(BASE_PLAN));
  const review = makeReview([
    {
      id: 'c1',
      type: 'remove-exercise',
      target: { routineId: 'r1', exId: '0007' },
      why: 'Remove exercise for deload'
    },
    {
      id: 'c2',
      type: 'sets',
      target: { routineId: 'r1', exId: '0001' },
      why: 'Increase sets',
      after: 5
    }
  ]);

  const merged = mergePlan(plan, review);
  const r1 = merged.routines.find(r => r.id === 'r1');
  assert.equal(r1.ex.length, 1);
  assert.equal(r1.ex[0].id, '0001');
  assert.equal(r1.ex[0].sets, 5);
});

/* =============================== Coach cardio toggle & validation (Issue #77) =============================== */

const VALID_ROUTINES = [
  { id: 'r1', name: 'Upper Body', ex: [{ id: '0001', sets: 3, reps: 10 }] },
  { id: 'r2', name: 'Lower Body', ex: [{ id: '0007', sets: 3, reps: 10 }] }
];

test('validatePlan rejects week cardio item when includeCardio is false or omitted (Issue #77)', () => {
  // Omitted includeCardio
  const res1 = validatePlan({
    routines: VALID_ROUTINES,
    week: { 1: 'r1', 3: { kind: 'cardio', type: 'run', duration: 30 } }
  });
  assert.equal(res1.ok, false);
  assert.ok(res1.errors.some(e => e.includes('Cardio sessions are disabled in coach profile')));

  // Explicit includeCardio: false
  const res2 = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: { 1: 'r1', 3: { kind: 'cardio', type: 'run', duration: 30 } }
    },
    { coachProfile: { includeCardio: false } }
  );
  assert.equal(res2.ok, false);
  assert.ok(res2.errors.some(e => e.includes('Cardio sessions are disabled in coach profile')));
});

test('validatePlan accepts valid cardio session in week when includeCardio is true (Issue #77)', () => {
  const res = validatePlan(
    {
      name: 'Hybrid Strength & Run',
      routines: VALID_ROUTINES,
      week: {
        1: 'r1',
        3: 'r2',
        5: { kind: 'cardio', type: 'run', duration: 35, distance: 5000, notes: 'Easy recovery run' }
      }
    },
    {
      coachProfile: {
        includeCardio: true,
        daysPerWeek: 2,
        cardioSessionsPerWeek: 1,
        cardioTypes: ['run', 'ride']
      }
    }
  );
  assert.equal(res.ok, true, `Validation failed: ${JSON.stringify(res.errors)}`);
  assert.equal(res.bundle.week[5].kind, 'cardio');
  assert.equal(res.bundle.week[5].type, 'run');
  assert.equal(res.bundle.week[5].duration, 35);
  assert.equal(res.bundle.week[5].distance, 5000);
});

test('validatePlan validates allowed cardioTypes vs standard types (Issue #77)', () => {
  // Disallowed type when standard types default
  const res1 = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: { 1: 'r1', 3: { kind: 'cardio', type: 'snowboard', duration: 60 } }
    },
    { includeCardio: true }
  );
  assert.equal(res1.ok, false);
  assert.ok(res1.errors.some(e => e.includes('snowboard') && e.includes('not an allowed cardio type')));

  // Allowed custom cardioTypes
  const res2 = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: { 1: 'r1', 3: { kind: 'cardio', type: 'swim', duration: 45 } }
    },
    {
      coachProfile: {
        includeCardio: true,
        cardioTypes: ['swim', 'row']
      }
    }
  );
  assert.equal(res2.ok, true);
  assert.equal(res2.bundle.week[3].type, 'swim');

  // Disallowed type when custom cardioTypes restricts it
  const res3 = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: { 1: 'r1', 3: { kind: 'cardio', type: 'ride', duration: 45 } }
    },
    {
      coachProfile: {
        includeCardio: true,
        cardioTypes: ['swim', 'row']
      }
    }
  );
  assert.equal(res3.ok, false);
  assert.ok(res3.errors.some(e => e.includes('ride') && e.includes('not an allowed cardio type')));
});

test('validatePlan rejects cardio session missing positive duration or distance (Issue #77)', () => {
  const res1 = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: { 1: 'r1', 3: { kind: 'cardio', type: 'run', duration: 0 } }
    },
    { includeCardio: true }
  );
  assert.equal(res1.ok, false);
  assert.ok(res1.errors.some(e => e.includes('duration must be a positive number')));

  const res2 = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: { 1: 'r1', 3: { kind: 'cardio', type: 'run', distance: -10 } }
    },
    { includeCardio: true }
  );
  assert.equal(res2.ok, false);
  assert.ok(res2.errors.some(e => e.includes('distance must be a positive number')));

  const res3 = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: { 1: 'r1', 3: { kind: 'cardio', type: 'run' } }
    },
    { includeCardio: true }
  );
  assert.equal(res3.ok, false);
  assert.ok(res3.errors.some(e => e.includes('must specify a positive duration or distance')));
});

test('validatePlan validates interval steps in cardio session (Issue #77)', () => {
  // Valid steps
  const valid = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: {
        1: 'r1',
        3: {
          kind: 'cardio',
          type: 'run',
          steps: [
            { kind: 'warmup', durSec: 300 },
            { kind: 'work', distM: 1000 },
            { kind: 'recover', durSec: 60 },
            { kind: 'cooldown', durSec: 300 }
          ]
        }
      }
    },
    { includeCardio: true }
  );
  assert.equal(valid.ok, true, `Should validate interval steps: ${JSON.stringify(valid.errors)}`);
  assert.equal(valid.bundle.week[3].steps.length, 4);
  assert.equal(valid.bundle.week[3].steps[0].kind, 'warmup');

  // Invalid step kind
  const badKind = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: {
        1: 'r1',
        3: {
          kind: 'cardio',
          type: 'run',
          steps: [{ kind: 'sprint', durSec: 60 }]
        }
      }
    },
    { includeCardio: true }
  );
  assert.equal(badKind.ok, false);
  assert.ok(badKind.errors.some(e => e.includes('kind must be one of')));

  // Missing positive durSec/distM
  const badDur = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: {
        1: 'r1',
        3: {
          kind: 'cardio',
          type: 'run',
          steps: [{ kind: 'work', durSec: 0 }]
        }
      }
    },
    { includeCardio: true }
  );
  assert.equal(badDur.ok, false);
  assert.ok(badDur.errors.some(e => e.includes('durSec must be a positive number')));
});

test('validatePlan enforces cardioSessionsPerWeek and daysPerWeek separation (Issue #77)', () => {
  // Exceeds cardioSessionsPerWeek
  const exceedCardio = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: {
        1: 'r1',
        2: { kind: 'cardio', type: 'run', duration: 30 },
        4: { kind: 'cardio', type: 'ride', duration: 45 }
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
  assert.equal(exceedCardio.ok, false);
  assert.ok(exceedCardio.errors.some(e => e.includes('2 cardio sessions which exceeds cardioSessionsPerWeek of 1')));

  // Cardio count does not count as gym days
  const gymMismatch = validatePlan(
    {
      routines: VALID_ROUTINES,
      week: {
        1: 'r1',
        3: { kind: 'cardio', type: 'run', duration: 30 }
      }
    },
    {
      coachProfile: {
        includeCardio: true,
        daysPerWeek: 2,
        cardioSessionsPerWeek: 1
      }
    }
  );
  assert.equal(gymMismatch.ok, false);
  assert.ok(gymMismatch.errors.some(e => e.includes('1 days but 2 were asked for')));
});

test('validateReview rejects week cardio change when includeCardio is false or omitted (Issue #77)', () => {
  const proposal = makeReview([
    {
      id: 'c1',
      type: 'week',
      target: { weekday: 4 },
      why: 'Add tempo run session',
      after: { kind: 'cardio', type: 'run', duration: 40 }
    }
  ]);

  // Omitted includeCardio
  const res1 = validateReview(proposal, BASE_PLAN);
  assert.equal(res1.ok, false);
  assert.ok(res1.errors.some(e => e.includes('Cardio sessions are disabled in coach profile')));

  // Explicit includeCardio: false
  const res2 = validateReview(proposal, BASE_PLAN, { coachProfile: { includeCardio: false } });
  assert.equal(res2.ok, false);
  assert.ok(res2.errors.some(e => e.includes('Cardio sessions are disabled in coach profile')));
});

test('validateReview accepts cardio week change and enforces cardioSessionsPerWeek (Issue #77)', () => {
  const proposal = makeReview([
    {
      id: 'c1',
      type: 'week',
      target: { weekday: 4 },
      why: 'Add aerobic base training',
      after: {
        kind: 'cardio',
        type: 'ride',
        duration: 45,
        steps: [
          { kind: 'warmup', durSec: 300 },
          { kind: 'work', durSec: 2100 },
          { kind: 'cooldown', durSec: 300 }
        ]
      }
    }
  ]);

  // Valid when within cardioSessionsPerWeek
  const res1 = validateReview(proposal, BASE_PLAN, {
    coachProfile: {
      includeCardio: true,
      cardioSessionsPerWeek: 1
    }
  });
  assert.equal(res1.ok, true, `Should validate: ${JSON.stringify(res1.errors)}`);
  assert.equal(res1.proposal.changes[0].after.kind, 'cardio');
  assert.equal(res1.proposal.changes[0].after.type, 'ride');
  assert.equal(res1.proposal.changes[0].after.steps.length, 3);

  // Rejects when total cardio sessions exceed cardioSessionsPerWeek
  const exceedProposal = makeReview([
    {
      id: 'c1',
      type: 'week',
      target: { weekday: 4 },
      why: 'Add first run',
      after: { kind: 'cardio', type: 'run', duration: 30 }
    },
    {
      id: 'c2',
      type: 'week',
      target: { weekday: 6 },
      why: 'Add second run',
      after: { kind: 'cardio', type: 'run', duration: 30 }
    }
  ]);
  const res2 = validateReview(exceedProposal, BASE_PLAN, {
    coachProfile: {
      includeCardio: true,
      cardioSessionsPerWeek: 1
    }
  });
  assert.equal(res2.ok, false);
  assert.ok(res2.errors.some(e => e.includes('2 cardio sessions which exceeds cardioSessionsPerWeek of 1')));
});

test('validatePlan rejects routines or week items when kind is disabled in profile.modalities (Issue #81)', () => {
  // HIIT disabled in modalities
  const res1 = validatePlan(
    {
      routines: [
        { id: 'r_hiit', name: 'Tabata Burn', kind: 'hiit', ex: [{ id: '0001', sets: 4, reps: 15 }] }
      ],
      week: { 1: 'r_hiit' }
    },
    {
      coachProfile: {
        modalities: { gym: true, cardio: true, hiit: false, yoga: true, mobility: true }
      }
    }
  );
  assert.equal(res1.ok, false);
  assert.ok(res1.errors.some(e => e.includes('Hiit routines are disabled in coach profile')));
  assert.ok(res1.errors.some(e => e.includes('Hiit sessions are disabled in coach profile')));

  // Gym disabled in modalities -> legacy routine (defaults to gym) rejected
  const res2 = validatePlan(
    {
      routines: [
        { id: 'r1', name: 'Strength A', ex: [{ id: '0001', sets: 3, reps: 10 }] }
      ],
      week: { 1: 'r1' }
    },
    {
      coachProfile: {
        modalities: { gym: false, cardio: true, hiit: true, yoga: true, mobility: true }
      }
    }
  );
  assert.equal(res2.ok, false);
  assert.ok(res2.errors.some(e => e.includes('Gym routines are disabled in coach profile')));
  assert.ok(res2.errors.some(e => e.includes('Gym sessions are disabled in coach profile')));
});

test('validatePlan accepts hiit, yoga, mobility with custom restSec and customEx when enabled (Issue #81)', () => {
  const res = validatePlan(
    {
      name: 'Hybrid Flow & Strength',
      summary: 'Integrated strength, flow, and conditioning.',
      routines: [
        {
          id: 'r_gym',
          name: 'Main Lifts',
          kind: 'gym',
          restSec: 120,
          ex: [{ id: '0001', sets: 3, reps: 8 }]
        },
        {
          id: 'r_hiit',
          name: 'Sprint Intervals',
          kind: 'hiit',
          restSec: 30,
          ex: [{ id: 'cx_hiit', sets: 4, reps: 15 }]
        },
        {
          id: 'r_yoga',
          name: 'Evening Stretch',
          kind: 'yoga',
          restSec: 0,
          ex: [{ id: '0007', sets: 3, mode: 'time', sec: 45 }]
        }
      ],
      customEx: [
        { id: 'cx_hiit', n: 'Kettlebell Burpee', bp: 'full body', desc: 'Explosive kettlebell burpee cleanly executed' }
      ],
      week: {
        1: 'r_gym',
        3: 'r_hiit',
        5: 'r_yoga'
      }
    },
    {
      coachProfile: {
        modalities: { gym: true, cardio: false, hiit: true, yoga: true, mobility: false },
        sessionsPerWeek: { gym: 1, hiit: 1, yoga: 1 }
      }
    }
  );

  assert.equal(res.ok, true, `Validation failed: ${JSON.stringify(res.errors)}`);
  assert.equal(res.bundle.routines.length, 3);
  assert.equal(res.bundle.routines[0].kind, 'gym');
  assert.equal(res.bundle.routines[0].restSec, 120);
  assert.equal(res.bundle.routines[1].kind, 'hiit');
  assert.equal(res.bundle.routines[1].restSec, 30);
  assert.equal(res.bundle.routines[2].kind, 'yoga');
  assert.equal(res.bundle.routines[2].restSec, 0);
  assert.equal(res.bundle.customEx[0].desc, 'Explosive kettlebell burpee cleanly executed');
});

test('validatePlan enforces session counts matching target sessionsPerWeek for enabled modalities (Issue #81)', () => {
  const planData = {
    routines: [
      { id: 'r_gym', name: 'Gym', kind: 'gym', ex: [{ id: '0001', sets: 3, reps: 8 }] },
      { id: 'r_hiit', name: 'HIIT', kind: 'hiit', ex: [{ id: '0001', sets: 3, reps: 10 }] }
    ],
    week: {
      1: 'r_gym',
      3: 'r_gym',
      5: 'r_hiit'
    }
  };

  // Mismatch on HIIT target (asked for 2, provided 1)
  const resBad = validatePlan(planData, {
    coachProfile: {
      modalities: { gym: true, cardio: false, hiit: true, yoga: false, mobility: false },
      sessionsPerWeek: { gym: 2, hiit: 2 }
    }
  });
  assert.equal(resBad.ok, false);
  assert.ok(resBad.errors.some(e => e.includes('1 hiit sessions but 2 were asked for')));

  // Match
  const resGood = validatePlan(planData, {
    coachProfile: {
      modalities: { gym: true, cardio: false, hiit: true, yoga: false, mobility: false },
      sessionsPerWeek: { gym: 2, hiit: 1 }
    }
  });
  assert.equal(resGood.ok, true, `Validation failed: ${JSON.stringify(resGood.errors)}`);
});

test('validateReview enforces modalities in add-routine and week changes, and applies cleanly with mergePlan (Issue #81)', () => {
  // Reject add-routine for disabled mobility modality
  const rejectAdd = makeReview([
    {
      id: 'c1',
      type: 'add-routine',
      why: 'Introduce hip mobility drills',
      after: {
        id: 'r_mob',
        name: 'Hip Flow',
        kind: 'mobility',
        restSec: 15,
        ex: [{ id: '0007', sets: 3, reps: 10 }]
      }
    }
  ]);
  const resReject = validateReview(rejectAdd, BASE_PLAN, {
    coachProfile: {
      modalities: { gym: true, cardio: false, hiit: false, yoga: false, mobility: false }
    }
  });
  assert.equal(resReject.ok, false);
  assert.ok(resReject.errors.some(e => e.includes('Mobility routines are disabled in coach profile')));

  // Accept add-routine when mobility enabled, preserving kind & restSec in mergePlan
  const acceptAdd = makeReview([
    {
      id: 'c1',
      type: 'add-routine',
      why: 'Introduce hip mobility drills',
      after: {
        id: 'r_mob',
        name: 'Hip Flow',
        kind: 'mobility',
        restSec: 15,
        ex: [{ id: '0007', sets: 3, reps: 10 }]
      }
    }
  ]);
  const resAccept = validateReview(acceptAdd, BASE_PLAN, {
    coachProfile: {
      modalities: { gym: true, cardio: false, hiit: false, yoga: false, mobility: true }
    }
  });
  assert.equal(resAccept.ok, true, `Should accept: ${JSON.stringify(resAccept.errors)}`);
  assert.equal(resAccept.proposal.changes[0].after.kind, 'mobility');
  assert.equal(resAccept.proposal.changes[0].after.restSec, 15);

  // Apply proposal via mergePlan
  const merged = mergePlan(structuredClone(BASE_PLAN), resAccept.proposal);
  const mobRoutine = merged.routines.find(r => r.name === 'Hip Flow');
  assert.ok(mobRoutine, 'routine added');
  assert.equal(mobRoutine.kind, 'mobility');
  assert.equal(mobRoutine.restSec, 15);
});
