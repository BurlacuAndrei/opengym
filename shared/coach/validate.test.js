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
