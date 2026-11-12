/* The gate between a language model's output and someone's training plan.
 *
 * Everything upstream of here is advisory — the prompt asks for a shape, the model usually
 * obliges. This file is where "usually" stops mattering. Nothing reaches a user that has not
 * resolved against the real exercise library, matched the closed list of change types, and
 * stayed inside the two things the Coach is allowed to touch (routines and the week).
 *
 * That closed list is the actual security boundary of the feature. A hostile note in a user's
 * free text can talk the model into saying anything at all; it cannot invent a change type,
 * and a change type that does not exist here does nothing.
 *
 * Errors are collected rather than thrown one at a time, because they are fed back to the
 * model verbatim for the one repair round (FR-48) — and a list of six problems produces a
 * better second attempt than the first of them does.
 */
import { libraryHas, libraryName, CONTRACT } from './payload.js';

// The closed list (FR-23 / C3). Adding a member here is a deliberate act with an apply
// implementation on the client to match; there is no default case anywhere.
export const CHANGE_TYPES = [
  'add-exercise', 'remove-exercise', 'swap-exercise',
  'sets', 'reps', 'repsMin', 'sec', 'cardio',
  'reorder', 'superset',
  'routine-prog', 'exercise-prog', 'inc',
  'add-routine', 'remove-routine', 'rename-routine',
  'week'
];
const POLICIES = ['off', 'linear', 'greyskull', 'double', 'time'];
const MODES = ['reps', 'time', 'cardio'];
const MAX_CHANGES = 25;
const MAX_ROUTINES = 7;
const MAX_EX_PER_ROUTINE = 20;

/**
 * Pull the JSON object out of whatever the CLI printed. Models fence their JSON, apologise
 * before it, or add a sign-off after it; none of that is worth failing a job over. A bare
 * parse is tried first so well-behaved output costs nothing.
 */
export function extractJSON(text) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'the provider returned nothing' };
  try { return { value: JSON.parse(raw) }; } catch { /* keep looking */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return { value: JSON.parse(fenced[1]) }; } catch { /* keep looking */ }
  }
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return { value: JSON.parse(raw.slice(first, last + 1)) }; } catch { /* give up */ }
  }
  return { error: 'the answer was not JSON' };
}

const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const clampStr = (v, n) => String(v == null ? '' : v).slice(0, n);

export const STANDARD_CARDIO_TYPES = ['run', 'ride', 'walk', 'hike'];
export const INTERVAL_STEP_KINDS = ['warmup', 'work', 'recover', 'cooldown'];

function validateCardioSession(item, { allowedTypes, where, errors }) {
  if (!item || typeof item !== 'object') {
    errors.push(`${where} must be an object`);
    return;
  }
  const type = isStr(item.type) ? item.type.toLowerCase().trim() : null;
  if (!type || !allowedTypes.has(type)) {
    errors.push(`${where}.type "${item.type}" is not an allowed cardio type — must be one of: ${[...allowedTypes].join(', ')}`);
  }

  const dur = item.duration ?? item.durMin ?? item.durationMin ?? item.durSec ?? item.min ?? item.sec ?? item.targetDurationMs;
  const dist = item.distance ?? item.distKm ?? item.distM ?? item.targetDistanceM ?? item.targetDistanceKm;

  if (dur != null && (!isNum(dur) || dur <= 0)) {
    errors.push(`${where}.duration must be a positive number`);
  }
  if (dist != null && (!isNum(dist) || dist <= 0)) {
    errors.push(`${where}.distance must be a positive number`);
  }

  const hasPosDur = isNum(dur) && dur > 0;
  const hasPosDist = isNum(dist) && dist > 0;

  if (item.steps != null) {
    if (!Array.isArray(item.steps)) {
      errors.push(`${where}.steps must be an array`);
    } else {
      item.steps.forEach((s, si) => {
        const sWhere = `${where}.steps[${si}]`;
        if (!s || typeof s !== 'object') {
          errors.push(`${sWhere} must be an object`);
          return;
        }
        const stepKind = isStr(s.kind || s.type) ? (s.kind || s.type).toLowerCase().trim() : null;
        if (!stepKind || !INTERVAL_STEP_KINDS.includes(stepKind)) {
          errors.push(`${sWhere}.kind must be one of: ${INTERVAL_STEP_KINDS.join(', ')}`);
        }
        const sDur = s.durSec ?? s.durationSec ?? (s.sec != null ? s.sec : null);
        const sDist = s.distM ?? s.distanceM ?? (s.dist != null ? s.dist : null);
        if (sDur != null && (!isNum(sDur) || sDur <= 0)) {
          errors.push(`${sWhere}.durSec must be a positive number`);
        }
        if (sDist != null && (!isNum(sDist) || sDist <= 0)) {
          errors.push(`${sWhere}.distM must be a positive number`);
        }
        if ((sDur == null || sDur <= 0) && (sDist == null || sDist <= 0)) {
          errors.push(`${sWhere} must specify positive durSec or distM`);
        }
      });
    }
  }

  const hasValidSteps = Array.isArray(item.steps) && item.steps.length > 0 &&
    item.steps.some(s => {
      const sDur = s?.durSec ?? s?.durationSec ?? s?.sec;
      const sDist = s?.distM ?? s?.distanceM ?? s?.dist;
      return (isNum(sDur) && sDur > 0) || (isNum(sDist) && sDist > 0);
    });

  if (!hasPosDur && !hasPosDist && !hasValidSteps) {
    errors.push(`${where} must specify a positive duration or distance`);
  }
}

function cleanCardioSession(item) {
  const clean = {
    kind: 'cardio',
    type: String(item.type || '').toLowerCase().trim()
  };
  if (item.id) clean.id = clampStr(item.id, 40);
  if (item.name) clean.name = clampStr(item.name, 60);
  if (isNum(item.duration) && item.duration > 0) clean.duration = item.duration;
  if (isNum(item.durMin) && item.durMin > 0) clean.durMin = item.durMin;
  if (isNum(item.durationMin) && item.durationMin > 0) clean.durationMin = item.durationMin;
  if (isNum(item.durSec) && item.durSec > 0) clean.durSec = item.durSec;
  if (isNum(item.min) && item.min > 0) clean.min = item.min;
  if (isNum(item.sec) && item.sec > 0) clean.sec = item.sec;
  if (isNum(item.targetDurationMs) && item.targetDurationMs > 0) clean.targetDurationMs = item.targetDurationMs;

  if (isNum(item.distance) && item.distance > 0) clean.distance = item.distance;
  if (isNum(item.distKm) && item.distKm > 0) clean.distKm = item.distKm;
  if (isNum(item.distM) && item.distM > 0) clean.distM = item.distM;
  if (isNum(item.targetDistanceM) && item.targetDistanceM > 0) clean.targetDistanceM = item.targetDistanceM;
  if (isNum(item.targetDistanceKm) && item.targetDistanceKm > 0) clean.targetDistanceKm = item.targetDistanceKm;

  if (isStr(item.notes)) clean.notes = clampStr(item.notes, 400);
  if (isStr(item.why)) clean.why = clampStr(item.why, 400);

  if (Array.isArray(item.steps)) {
    clean.steps = item.steps.map(s => {
      const stepClean = {
        kind: String(s.kind || s.type || '').toLowerCase().trim()
      };
      if (s.id) stepClean.id = clampStr(s.id, 40);
      const dSec = s.durSec ?? s.durationSec ?? s.sec;
      if (isNum(dSec) && dSec > 0) stepClean.durSec = dSec;
      const dM = s.distM ?? s.distanceM ?? s.dist;
      if (isNum(dM) && dM > 0) stepClean.distM = dM;
      if (s.targetSpeed != null) stepClean.targetSpeed = s.targetSpeed;
      if (s.targetPace != null) stepClean.targetPace = s.targetPace;
      if (s.targetHrZone != null) stepClean.targetHrZone = s.targetHrZone;
      return stepClean;
    });
  }
  return clean;
}

/* =============================== created plans =============================== */

/**
 * Validate a creation bundle into something `mergePlan` can consume unchanged.
 * Returns { ok, bundle } or { ok:false, errors }.
 */
export function validatePlan(data, ctx = {}) {
  const errors = [];
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  if (data.nochange) return fail(['a plan was requested but the answer said "no change"']);
  if (!Array.isArray(data.routines) || !data.routines.length) errors.push('routines must be a non-empty array');

  const coachProfile = ctx.coachProfile || ctx.profile || ctx;
  const includeCardio = Boolean(coachProfile.includeCardio ?? ctx.includeCardio);
  const rawTypes = coachProfile.cardioTypes || ctx.cardioTypes;
  const cardioTypes = Array.isArray(rawTypes) && rawTypes.length ? rawTypes : STANDARD_CARDIO_TYPES;
  const allowedCardioTypes = new Set(cardioTypes.map(t => String(t).toLowerCase()));
  const cardioSessionsPerWeek = coachProfile.cardioSessionsPerWeek ?? ctx.cardioSessionsPerWeek;
  const daysPerWeek = coachProfile.daysPerWeek ?? ctx.daysPerWeek;

  const customEx = (Array.isArray(data.customEx) ? data.customEx : [])
    .filter(c => c && isStr(c.id) && isStr(c.n))
    .slice(0, 20)
    .map(c => ({ id: clampStr(c.id, 40), n: clampStr(c.n, 60), bp: clampStr(c.bp || 'waist', 30), ...(c.desc ? { desc: clampStr(c.desc, 400) } : {}) }));
  const proposedIds = new Set(customEx.map(c => c.id));
  const ctxCustomIds = new Set((ctx.customEx || []).map(c => (typeof c === 'string' ? c : c?.id)));

  const routines = [];
  (Array.isArray(data.routines) ? data.routines : []).slice(0, MAX_ROUTINES).forEach((r, ri) => {
    if (!r || typeof r !== 'object') { errors.push(`routines[${ri}] is not an object`); return; }
    if (!isStr(r.name)) errors.push(`routines[${ri}].name is required`);
    if (r.prog != null && !POLICIES.includes(r.prog)) errors.push(`routines[${ri}].prog "${r.prog}" is not one of ${POLICIES.join(', ')}`);
    const ex = [];
    (Array.isArray(r.ex) ? r.ex : []).slice(0, MAX_EX_PER_ROUTINE).forEach((e, ei) => {
      const where = `routines[${ri}].ex[${ei}]`;
      if (!e || !isStr(e.id)) { errors.push(`${where}.id is required`); return; }
      // FR-16: an id that resolves to nothing invalidates the proposal rather than being
      // dropped into a plan that renders blank the first time it is trained.
      if (!libraryHas(e.id) && !proposedIds.has(e.id) && !ctxCustomIds.has(e.id) && !(typeof e.id === 'string' && e.id.startsWith('cust_'))) {
        errors.push(`${where}.id "${e.id}" is not in the exercise library and is not one of your own customEx entries — use an id from the library provided in the payload`);
        return;
      }
      const clean = { id: e.id, sets: isInt(e.sets, 1, 10) ? e.sets : 3 };
      const mode = MODES.includes(e.mode) ? e.mode : 'reps';
      if (mode === 'cardio') {
        clean.min = isInt(e.min, 1, 180) ? e.min : 20;
        clean.speed = isNum(e.speed) && e.speed > 0 ? e.speed : 8;
      } else if (mode === 'time') {
        clean.mode = 'time';
        clean.sec = isInt(e.sec, 5, 3600) ? e.sec : 45;
        if (isNum(e.weight) && e.weight > 0) clean.weight = e.weight;
      } else {
        clean.mode = 'reps';
        clean.reps = isInt(e.reps, 1, 100) ? e.reps : 10;
        if (isNum(e.weight) && e.weight > 0) clean.weight = e.weight;
      }
      if (e.prog != null) {
        if (!POLICIES.includes(e.prog)) errors.push(`${where}.prog "${e.prog}" is not one of ${POLICIES.join(', ')}`);
        else clean.prog = e.prog;
      }
      if (isNum(e.inc) && e.inc > 0) clean.inc = e.inc;
      if (isInt(e.repsMin, 1, 100)) clean.repsMin = e.repsMin;
      if (isStr(e.sg)) clean.sg = clampStr(e.sg, 20);
      if (isStr(e.why)) clean.why = clampStr(e.why, 400);
      ex.push(clean);
    });
    if (!ex.length) errors.push(`routines[${ri}] has no valid exercises`);
    routines.push({
      id: isStr(r.id) ? clampStr(r.id, 40) : 'r' + ri,
      name: clampStr(r.name || 'Routine', 40),
      emoji: clampStr(r.emoji || '🏋️', 8),
      ...(POLICIES.includes(r.prog) ? { prog: r.prog } : {}),
      ...(isStr(r.why) ? { why: clampStr(r.why, 400) } : {}),
      ex
    });
  });

  // The week may only point at routines this bundle actually defines or valid cardio sessions.
  const known = new Set(routines.map(r => r.id));
  const week = {};
  let gymSessionsCount = 0;
  let cardioSessionsCount = 0;

  Object.entries(data.week || {}).forEach(([d, val]) => {
    const day = +d;
    if (!isInt(day, 0, 6)) { errors.push(`week key "${d}" is not a weekday number 0-6`); return; }

    const rawItems = Array.isArray(val) ? val : [val];
    const cleanedItems = [];

    for (let idx = 0; idx < rawItems.length; idx++) {
      const item = rawItems[idx];
      const where = `week[${d}]` + (Array.isArray(val) ? `[${idx}]` : '');

      if (item == null || item === 'rest') {
        continue;
      }

      if (typeof item === 'string') {
        if (!known.has(item)) {
          errors.push(`week[${d}] points at "${item}", which is not one of the routines in this plan`);
        } else {
          gymSessionsCount++;
          cleanedItems.push(item);
        }
      } else if (typeof item === 'object') {
        if (item.kind === 'cardio') {
          if (!includeCardio) {
            errors.push('Cardio sessions are disabled in coach profile');
          } else {
            validateCardioSession(item, { allowedTypes: allowedCardioTypes, where, errors });
            cardioSessionsCount++;
            cleanedItems.push(cleanCardioSession(item));
          }
        } else if (item.routineId && known.has(item.routineId)) {
          gymSessionsCount++;
          cleanedItems.push(item);
        } else if (item.routineId && !known.has(item.routineId)) {
          errors.push(`week[${d}] points at "${item.routineId}", which is not one of the routines in this plan`);
        } else {
          errors.push(`${where} is not a valid routine reference or cardio session`);
        }
      } else {
        errors.push(`${where} is not a valid routine or cardio session`);
      }
    }

    if (cleanedItems.length > 0) {
      week[day] = Array.isArray(val) ? cleanedItems : cleanedItems[0];
    }
  });

  // FR-20: never start someone above what they have actually lifted.
  const caps = new Map((ctx.workingWeights || []).map(w => [w.id, w.best]));
  routines.forEach(r => r.ex.forEach(e => {
    const cap = caps.get(e.id);
    if (cap != null && e.weight > cap) e.weight = cap;
  }));

  // FR-17: honour the number of training days the user asked for.
  const want = daysPerWeek;
  if (isInt(want, 1, 7) && Object.keys(week).length && gymSessionsCount !== want) {
    errors.push(`the week schedules ${gymSessionsCount} days but ${want} were asked for`);
  }

  if (cardioSessionsPerWeek != null) {
    if (!isInt(cardioSessionsPerWeek, 1, 7)) {
      errors.push('cardioSessionsPerWeek must be a number between 1 and 7');
    } else if (cardioSessionsCount > cardioSessionsPerWeek) {
      errors.push(`the week schedules ${cardioSessionsCount} cardio sessions which exceeds cardioSessionsPerWeek of ${cardioSessionsPerWeek}`);
    }
  }

  if (errors.length) return fail(errors);
  return {
    ok: true,
    bundle: {
      opengym_plan: 1,
      name: clampStr(data.name || 'Coach plan', 40),
      summary: clampStr(data.summary || '', 1200),
      basedOn: clampStr(data.basedOn || '', 400),
      week, routines, customEx
    }
  };
}

/* =============================== review change-sets =============================== */

/**
 * Validate a review answer. Returns { ok, nochange } | { ok, proposal } | { ok:false, errors }.
 * `plan` is the payload's cleaned plan — every target must resolve against it, so a change
 * aimed at a routine that no longer exists never reaches the review screen.
 */
export function validateReview(data, plan, options = {}) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  if (data.nochange) {
    return { ok: true, nochange: true, reading: clampStr(data.reading || data.summary || '', 1200) };
  }
  const errors = [];
  const routines = new Map((plan?.routines || []).map(r => [r.id, r]));
  const changes = [];
  const list = Array.isArray(data.changes) ? data.changes : null;
  if (!list) return fail(['changes must be an array (or set "nochange": true with a "reading")']);

  const coachProfile = options.coachProfile || options.profile || options;
  const includeCardio = Boolean(coachProfile.includeCardio ?? options.includeCardio);
  const rawTypes = coachProfile.cardioTypes || options.cardioTypes;
  const cardioTypes = Array.isArray(rawTypes) && rawTypes.length ? rawTypes : STANDARD_CARDIO_TYPES;
  const allowedCardioTypes = new Set(cardioTypes.map(t => String(t).toLowerCase()));
  const cardioSessionsPerWeek = coachProfile.cardioSessionsPerWeek ?? options.cardioSessionsPerWeek;
  const daysPerWeek = coachProfile.daysPerWeek ?? options.daysPerWeek;

  if (data.week && typeof data.week === 'object') {
    Object.entries(data.week).forEach(([d, val]) => {
      const items = Array.isArray(val) ? val : [val];
      items.forEach((item, idx) => {
        if (item && typeof item === 'object' && item.kind === 'cardio') {
          if (!includeCardio) {
            errors.push('Cardio sessions are disabled in coach profile');
          } else {
            validateCardioSession(item, { allowedTypes: allowedCardioTypes, where: `week[${d}]` + (Array.isArray(val) ? `[${idx}]` : ''), errors });
          }
        }
      });
    });
  }

  const customExList = Array.isArray(options?.customEx)
    ? options.customEx
    : (Array.isArray(plan?.customEx) ? plan.customEx : []);

  const customMap = new Map();
  for (const c of customExList) {
    if (typeof c === 'string') {
      customMap.set(c, { id: c, n: c });
    } else if (c && typeof c === 'object' && c.id) {
      customMap.set(c.id, c);
    }
  }

  const libOptions = options?.library;
  const isLibraryEx = id => {
    if (libOptions) {
      if (Array.isArray(libOptions)) return libOptions.some(e => e && e.id === id);
      if (typeof libOptions.has === 'function') return libOptions.has(id);
    }
    return libraryHas(id);
  };

  const getLibraryName = id => {
    if (libOptions) {
      if (Array.isArray(libOptions)) {
        const found = libOptions.find(e => e && e.id === id);
        if (found) return found.n || found.name || id;
      } else if (typeof libOptions.get === 'function') {
        const found = libOptions.get(id);
        if (found) return found.n || found.name || id;
      }
    }
    return libraryName(id);
  };

  const isValidEx = id => {
    if (!isStr(id)) return false;
    if (isLibraryEx(id)) return true;
    if (customMap.has(id)) return true;
    if (id.startsWith('cust_')) return true;
    return false;
  };

  const getExName = (id, fallback) => {
    if (customMap.has(id)) {
      const c = customMap.get(id);
      return c.n || c.name || fallback || id;
    }
    if (isLibraryEx(id)) {
      return getLibraryName(id) || fallback || id;
    }
    if (id.startsWith('cust_')) {
      return fallback || id;
    }
    return fallback || id;
  };

  list.slice(0, MAX_CHANGES).forEach((c, i) => {
    const where = `changes[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!CHANGE_TYPES.includes(c.type)) {
      errors.push(`${where}.type "${c.type}" is not allowed — use one of: ${CHANGE_TYPES.join(', ')}`);
      return;
    }
    if (!isStr(c.why)) { errors.push(`${where}.why is required — every change must cite the evidence behind it`); return; }
    const target = c.target || {};
    const routine = target.routineId ? routines.get(target.routineId) : null;

    // Targets: everything but add-routine and week must name a routine that exists; anything
    // touching an exercise must name one that is actually in it.
    if (!['add-routine', 'week'].includes(c.type)) {
      if (!routine) { errors.push(`${where}.target.routineId "${target.routineId}" is not one of the routines in the plan`); return; }
    }
    const needsEx = ['remove-exercise', 'swap-exercise', 'sets', 'reps', 'repsMin', 'sec', 'cardio', 'exercise-prog', 'inc', 'superset'];
    if (needsEx.includes(c.type)) {
      if (!target.exId) { errors.push(`${where}.target.exId is required for type "${c.type}"`); return; }
      if (!(routine.ex || []).some(e => e.id === target.exId)) {
        errors.push(`${where}.target.exId "${target.exId}" is not in routine "${routine.name}"`); return;
      }
    }

    const out = {
      id: isStr(c.id) ? clampStr(c.id, 40) : 'c' + i,
      type: c.type,
      target: {
        ...(target.routineId ? { routineId: target.routineId } : {}),
        ...(target.exId ? { exId: target.exId } : {}),
        ...(isInt(target.weekday, 0, 6) ? { weekday: target.weekday } : {})
      },
      why: clampStr(c.why, 600),
      before: c.before ?? null,
      after: c.after ?? null
    };

    // Per-type checks on `after`. `before` is informational here — the client verifies it
    // against the live plan at apply time, which is where staleness actually matters.
    switch (c.type) {
      case 'add-exercise': {
        const a = c.after || {};
        if (!isStr(a.id) || !isValidEx(a.id)) { errors.push(`${where}.after.id must be an exercise id from the library`); return; }
        out.after = {
          id: a.id, name: getExName(a.id, a.name),
          sets: isInt(a.sets, 1, 10) ? a.sets : 3,
          ...(MODES.includes(a.mode) ? { mode: a.mode } : { mode: 'reps' }),
          ...(isInt(a.reps, 1, 100) ? { reps: a.reps } : {}),
          ...(isInt(a.sec, 5, 3600) ? { sec: a.sec } : {}),
          ...(isNum(a.weight) && a.weight > 0 ? { weight: a.weight } : {}),
          ...(POLICIES.includes(a.prog) ? { prog: a.prog } : {}),
          ...(isInt(a.position, 0, MAX_EX_PER_ROUTINE) ? { position: a.position } : {})
        };
        break;
      }
      case 'swap-exercise': {
        const a = c.after || {};
        if (!isStr(a.id) || !isValidEx(a.id)) { errors.push(`${where}.after.id must be an exercise id from the library`); return; }
        if (a.id === target.exId) { errors.push(`${where} swaps an exercise for itself`); return; }
        out.after = {
          id: a.id, name: getExName(a.id, a.name),
          ...(isInt(a.sets, 1, 10) ? { sets: a.sets } : {}),
          ...(isInt(a.reps, 1, 100) ? { reps: a.reps } : {}),
          ...(isNum(a.weight) && a.weight > 0 ? { weight: a.weight } : {})
        };
        break;
      }
      case 'remove-exercise':
      case 'remove-routine':
        out.after = null;
        break;
      case 'sets': if (!isInt(c.after, 1, 10)) { errors.push(`${where}.after must be a whole number of sets (1-10)`); return; } break;
      case 'reps': if (!isInt(c.after, 1, 100)) { errors.push(`${where}.after must be a whole number of reps (1-100)`); return; } break;
      case 'repsMin': if (!isInt(c.after, 1, 100)) { errors.push(`${where}.after must be a whole number (1-100)`); return; } break;
      case 'sec': if (!isInt(c.after, 5, 3600) ) { errors.push(`${where}.after must be seconds (5-3600)`); return; } break;
      case 'cardio': {
        const a = c.after || {};
        if (!isInt(a.min, 1, 180) && !isNum(a.speed)) { errors.push(`${where}.after must carry min and/or speed`); return; }
        out.after = { ...(isInt(a.min, 1, 180) ? { min: a.min } : {}), ...(isNum(a.speed) && a.speed > 0 ? { speed: a.speed } : {}) };
        break;
      }
      case 'inc': if (!isNum(c.after) || c.after <= 0) { errors.push(`${where}.after must be a positive increment`); return; } break;
      case 'routine-prog':
      case 'exercise-prog':
        if (!POLICIES.includes(c.after)) { errors.push(`${where}.after must be one of ${POLICIES.join(', ')}`); return; }
        break;
      case 'reorder': {
        const order = Array.isArray(c.after) ? c.after : null;
        if (!order) { errors.push(`${where}.after must be an array of exercise ids in the new order`); return; }
        const have = (routine.ex || []).map(e => e.id);
        if (order.length !== have.length || order.some(id => !have.includes(id))) {
          errors.push(`${where}.after must list exactly the ${have.length} exercise ids already in "${routine.name}", reordered`); return;
        }
        out.after = order;
        break;
      }
      case 'superset': {
        const a = c.after || {};
        if (a.link && !isStr(a.with)) { errors.push(`${where}.after.with is required when linking a superset`); return; }
        if (a.link && !(routine.ex || []).some(e => e.id === a.with)) { errors.push(`${where}.after.with "${a.with}" is not in routine "${routine.name}"`); return; }
        out.after = { link: !!a.link, ...(a.link ? { with: a.with } : {}) };
        break;
      }
      case 'add-routine': {
        const a = c.after || {};
        if (!isStr(a.name)) { errors.push(`${where}.after.name is required`); return; }
        const ex = (Array.isArray(a.ex) ? a.ex : []).filter(e => e && isStr(e.id) && isValidEx(e.id)).slice(0, MAX_EX_PER_ROUTINE);
        if (!ex.length) { errors.push(`${where}.after.ex must list at least one exercise from the library`); return; }
        out.after = {
          name: clampStr(a.name, 40), emoji: clampStr(a.emoji || '🏋️', 8),
          ...(POLICIES.includes(a.prog) ? { prog: a.prog } : {}),
          ex: ex.map(e => ({
            id: e.id, name: getExName(e.id, e.name),
            sets: isInt(e.sets, 1, 10) ? e.sets : 3,
            mode: MODES.includes(e.mode) ? e.mode : 'reps',
            ...(isInt(e.reps, 1, 100) ? { reps: e.reps } : {}),
            ...(isInt(e.sec, 5, 3600) ? { sec: e.sec } : {})
          }))
        };
        break;
      }
      case 'rename-routine':
        if (!isStr(c.after)) { errors.push(`${where}.after must be the new routine name`); return; }
        out.after = clampStr(c.after, 40);
        break;
      case 'week': {
        if (!isInt(target.weekday, 0, 6)) { errors.push(`${where}.target.weekday must be 0-6`); return; }
        // null/'rest' clears the day; anything else has to be a routine that exists or cardio session.
        if (c.after == null || c.after === 'rest') {
          out.after = c.after ?? null;
          break;
        }

        const rawItems = Array.isArray(c.after) ? c.after : [c.after];
        const cleanedItems = [];

        for (let idx = 0; idx < rawItems.length; idx++) {
          const item = rawItems[idx];
          const itemWhere = `${where}.after` + (Array.isArray(c.after) ? `[${idx}]` : '');

          if (item == null || item === 'rest') {
            continue;
          }
          if (typeof item === 'string') {
            if (!routines.has(item)) {
              errors.push(`${where}.after must be a routine id from the plan, "rest", or null`);
            } else {
              cleanedItems.push(item);
            }
          } else if (typeof item === 'object') {
            if (item.kind === 'cardio') {
              if (!includeCardio) {
                errors.push('Cardio sessions are disabled in coach profile');
              } else {
                validateCardioSession(item, { allowedTypes: allowedCardioTypes, where: itemWhere, errors });
                cleanedItems.push(cleanCardioSession(item));
              }
            } else if (item.routineId && routines.has(item.routineId)) {
              cleanedItems.push(item);
            } else if (item.routineId && !routines.has(item.routineId)) {
              errors.push(`${where}.after must be a routine id from the plan, "rest", or null`);
            } else {
              errors.push(`${itemWhere} must be a routine id from the plan, "rest", or cardio session`);
            }
          } else {
            errors.push(`${itemWhere} must be a routine id from the plan, "rest", or null`);
          }
        }

        out.after = Array.isArray(c.after) ? cleanedItems : (cleanedItems[0] ?? null);
        break;
      }
    }
    changes.push(out);
  });

  // Check projected week schedule if week changes or cardio sessions exist
  const projectedWeek = {};
  if (plan && plan.week) {
    for (const [d, val] of Object.entries(plan.week)) {
      projectedWeek[d] = val;
    }
  }
  for (const c of changes) {
    if (c.type === 'week' && c.target && c.target.weekday != null) {
      if (c.after == null || c.after === 'rest') {
        delete projectedWeek[c.target.weekday];
      } else {
        projectedWeek[c.target.weekday] = c.after;
      }
    }
  }

  let projectedCardioCount = 0;
  let projectedGymCount = 0;
  for (const val of Object.values(projectedWeek)) {
    const items = Array.isArray(val) ? val : [val];
    for (const item of items) {
      if (typeof item === 'string' && routines.has(item)) projectedGymCount++;
      else if (item && typeof item === 'object') {
        if (item.kind === 'cardio') projectedCardioCount++;
        else if (item.routineId && routines.has(item.routineId)) projectedGymCount++;
      }
    }
  }

  if (cardioSessionsPerWeek != null) {
    if (!isInt(cardioSessionsPerWeek, 1, 7)) {
      errors.push('cardioSessionsPerWeek must be a number between 1 and 7');
    } else if (projectedCardioCount > cardioSessionsPerWeek) {
      errors.push(`the week schedules ${projectedCardioCount} cardio sessions which exceeds cardioSessionsPerWeek of ${cardioSessionsPerWeek}`);
    }
  }

  const hasWeekChange = changes.some(c => c.type === 'week');
  if (hasWeekChange && isInt(daysPerWeek, 1, 7) && Object.keys(projectedWeek).length > 0 && projectedGymCount !== daysPerWeek) {
    errors.push(`the week schedules ${projectedGymCount} days but ${daysPerWeek} were asked for`);
  }

  if (errors.length) return fail(errors);
  if (!changes.length) {
    // An empty change list and "no changes" are the same outcome; treat it as the latter
    // rather than showing someone an empty proposal screen (FR-25).
    return { ok: true, nochange: true, reading: clampStr(data.summary || data.reading || '', 1200) };
  }
  return {
    ok: true,
    proposal: {
      summary: clampStr(data.summary || '', 1200),
      evidence: {
        from: data.evidence?.from || null,
        to: data.evidence?.to || null,
        sessions: isInt(data.evidence?.sessions, 0, 10000) ? data.evidence.sessions : null
      },
      changes,
      notes: (Array.isArray(data.notes) ? data.notes : []).filter(isStr).slice(0, 6).map(n => clampStr(n, 600))
    }
  };
}

function fail(errors) { return { ok: false, errors }; }

/** Contract-version guard: a payload we understand answered by something we don't. */
export const contractOK = data => !data?.coach_contract || data.coach_contract === CONTRACT;
