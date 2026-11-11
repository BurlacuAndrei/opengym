import { LIB_BY_ID } from './library.js';

export const modeOf = (cfg, ex) => {
  const m = cfg && cfg.mode;
  if (m === 'reps' || m === 'time' || m === 'cardio') return m;
  return ex && ex.bp === 'cardio' ? 'cardio' : 'reps';
};

/**
 * Normalizes a single session value or session array into an array of routine/session IDs.
 * Transparently accepts string ('r1'), array of strings (['r1', 'r2']), or null/undefined.
 */
export function getSessions(val) {
  if (Array.isArray(val)) return val.filter(x => typeof x === 'string' && x.trim() !== '');
  if (typeof val === 'string' && val.trim() !== '') return [val];
  return [];
}

/**
 * Accessor for the primary or first session of a day, transparently handling string and array formats.
 */
export function getFirstSession(val) {
  if (Array.isArray(val)) return val[0] || null;
  if (typeof val === 'string' && val.trim() !== '') return val;
  return null;
}

/**
 * Normalizes an entire week or dayPlan schedule mapping to session arrays.
 */
export function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(schedule)) {
    const sessions = getSessions(v);
    if (sessions.length > 0) out[k] = sessions;
  }
  return out;
}

/**
 * Accessor helper to retrieve sessions for a given date in dayPlan.
 */
export function getDaySessions(planOrState, date, field = 'dayPlan') {
  return getSessions(planOrState?.[field]?.[date]);
}

/**
 * Accessor helper to retrieve sessions for a given weekday in week.
 */
export function getWeekSessions(planOrState, day) {
  return getSessions(planOrState?.week?.[day]);
}

/**
 * The plan reduced to exactly the fields that decide whether it has *changed* — mode-aware,
 * with every absent value written out as a zero so "no weight" and "0 kg" cannot hash apart.
 */
export function canonicalPlan(S) {
  const custom = new Map((S?.customEx || []).map(c => [c.id, c]));
  const exOf = id => LIB_BY_ID.get(id) || custom.get(id);
  const weekObj = {};
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const sessions = getSessions(S?.week?.[d]);
    if (sessions.length > 0) weekObj[d] = sessions;
  }
  return {
    routines: (S?.routines || []).map(r => ({
      id: r.id, name: r.name || '', prog: r.prog || '',
      ex: (r.ex || []).map(e => {
        const mode = modeOf(e, exOf(e.id));
        return {
          id: e.id, mode, sets: e.sets || 0,
          reps: mode === 'reps' ? (e.reps || 0) : 0,
          sec: mode === 'time' ? (e.sec || 0) : 0,
          min: mode === 'cardio' ? (e.min || 0) : 0,
          speed: mode === 'cardio' ? (e.speed || 0) : 0,
          weight: mode === 'cardio' ? 0 : (e.weight || 0),
          prog: e.prog || '', inc: e.inc || 0, repsMin: e.repsMin || 0, sg: e.sg || ''
        };
      })
    })),
    week: weekObj
  };
}

/**
 * Fingerprint of the plan a proposal was computed against (FR-32). Takes the output of
 * `canonicalPlan`, so both runtimes hash the same normalised shape; the client mirrors this
 * function exactly. A mismatch therefore means the plan genuinely moved — not that two
 * implementations disagree about key order or about what "no weight" looks like.
 */
export function hashPlan(plan) {
  const canon = JSON.stringify({
    routines: (plan?.routines || []).map(r => [r.id, r.name, r.prog, (r.ex || []).map(e =>
      [e.id, e.mode, e.sets, e.reps, e.sec, e.min, e.speed, e.weight, e.prog, e.inc, e.repsMin, e.sg].join(':')
    )]),
    week: Object.keys(plan?.week || {}).sort().map(k => {
      const val = plan.week[k];
      const s = Array.isArray(val) ? val.join(',') : (val != null ? String(val) : '');
      return k + '=' + s;
    })
  });
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < canon.length; i++) {
    const c = canon.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 3) | i & 7), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export const planHash = S => hashPlan(canonicalPlan(S));

/**
 * Merge a review proposal, change-set, or plan bundle into a plan, treating custom exercises (customEx)
 * as first-class exercises.
 */
export function mergePlan(plan, review, { customEx = [] } = {}) {
  if (!plan) return plan;

  plan.routines = plan.routines || [];
  plan.week = plan.week || {};
  plan.customEx = plan.customEx || [];

  if (Array.isArray(customEx)) {
    const existing = new Set(plan.customEx.map(c => (typeof c === 'string' ? c : c?.id)));
    for (const c of customEx) {
      const cid = typeof c === 'string' ? c : c?.id;
      if (cid && !existing.has(cid)) {
        plan.customEx.push(typeof c === 'string' ? { id: c, n: c, custom: true } : c);
        existing.add(cid);
      }
    }
  }

  const ensureCustomRegistered = (id, fallbackName) => {
    if (!id || typeof id !== 'string') return;
    const isCustom = id.startsWith('cust_') || (Array.isArray(customEx) && customEx.some(x => (x?.id || x) === id));
    if (!isCustom) return;
    const found = plan.customEx.find(x => (x?.id || x) === id);
    if (!found) {
      const meta = (Array.isArray(customEx) ? customEx.find(x => (x?.id || x) === id) : null);
      if (meta && typeof meta === 'object') {
        plan.customEx.push({ ...meta });
      } else {
        plan.customEx.push({ id, n: fallbackName || id, custom: true });
      }
    }
  };

  const changes = Array.isArray(review)
    ? review
    : (review?.proposal?.changes || review?.changes);

  if (Array.isArray(changes)) {
    for (const c of changes) {
      if (!c || typeof c !== 'object') continue;
      const type = c.type;
      const target = c.target || {};
      const routineId = target.routineId || c.routineId;
      const r = routineId ? plan.routines.find(rt => rt.id === routineId) : plan.routines[0];

      switch (type) {
        case 'add-exercise':
        case 'add': {
          if (!r) break;
          r.ex = r.ex || [];
          const a = c.after || {};
          const exId = a.id || c.exId;
          if (!exId) break;
          const e = {
            id: exId,
            sets: a.sets ?? 3,
            mode: a.mode ?? modeOf(a, LIB_BY_ID.get(exId))
          };
          if (e.mode === 'cardio') {
            e.min = a.min ?? 20;
            e.speed = a.speed ?? 8;
          } else if (e.mode === 'time') {
            e.sec = a.sec ?? 45;
            if (a.weight > 0) e.weight = a.weight;
          } else {
            e.reps = a.reps ?? 10;
            if (a.weight > 0) e.weight = a.weight;
          }
          if (a.prog) e.prog = a.prog;
          if (a.inc > 0) e.inc = a.inc;
          if (a.repsMin != null) e.repsMin = a.repsMin;
          if (a.sg) e.sg = a.sg;

          const pos = Number.isInteger(a.position) ? Math.min(a.position, r.ex.length) : r.ex.length;
          r.ex.splice(pos, 0, e);
          ensureCustomRegistered(exId, a.name);
          break;
        }

        case 'swap-exercise':
        case 'replace':
        case 'swap': {
          if (!r || !r.ex) break;
          const targetExId = target.exId || c.targetExId || c.before?.id || (typeof c.before === 'string' ? c.before : null);
          const i = targetExId ? r.ex.findIndex(e => e.id === targetExId) : -1;
          if (i < 0) break;
          const old = r.ex[i];
          const a = c.after || {};
          const newId = a.id || c.newId || (typeof c.after === 'string' ? c.after : null);
          if (!newId) break;
          r.ex[i] = {
            ...old,
            id: newId,
            ...(a.sets != null ? { sets: a.sets } : {}),
            ...(a.reps != null ? { reps: a.reps } : {}),
            ...(a.sec != null ? { sec: a.sec } : {}),
            ...(a.min != null ? { min: a.min } : {}),
            ...(a.speed != null ? { speed: a.speed } : {}),
            ...(a.weight != null && a.weight > 0 ? { weight: a.weight } : {}),
            ...(a.mode ? { mode: a.mode } : {}),
            ...(a.prog ? { prog: a.prog } : {})
          };
          ensureCustomRegistered(newId, a.name);
          break;
        }

        case 'remove-exercise':
        case 'remove': {
          if (!r || !r.ex) break;
          const targetExId = target.exId || c.targetExId || c.before?.id || (typeof c.before === 'string' ? c.before : null);
          if (targetExId) {
            r.ex = r.ex.filter(e => e.id !== targetExId);
          }
          break;
        }

        case 'sets': {
          if (!r || !r.ex) break;
          const ex = r.ex.find(e => e.id === target.exId);
          if (ex && c.after != null) ex.sets = c.after;
          break;
        }

        case 'reps': {
          if (!r || !r.ex) break;
          const ex = r.ex.find(e => e.id === target.exId);
          if (ex && c.after != null) ex.reps = c.after;
          break;
        }

        case 'repsMin': {
          if (!r || !r.ex) break;
          const ex = r.ex.find(e => e.id === target.exId);
          if (ex && c.after != null) ex.repsMin = c.after;
          break;
        }

        case 'sec': {
          if (!r || !r.ex) break;
          const ex = r.ex.find(e => e.id === target.exId);
          if (ex && c.after != null) ex.sec = c.after;
          break;
        }

        case 'cardio': {
          if (!r || !r.ex) break;
          const ex = r.ex.find(e => e.id === target.exId);
          if (ex) {
            if (c.after?.min != null) ex.min = c.after.min;
            if (c.after?.speed != null) ex.speed = c.after.speed;
          }
          break;
        }

        case 'inc': {
          if (!r || !r.ex) break;
          const ex = r.ex.find(e => e.id === target.exId);
          if (ex && c.after != null) ex.inc = c.after;
          break;
        }

        case 'exercise-prog': {
          if (!r || !r.ex) break;
          const ex = r.ex.find(e => e.id === target.exId);
          if (ex && c.after != null) ex.prog = c.after;
          break;
        }

        case 'routine-prog': {
          if (r && c.after != null) r.prog = c.after;
          break;
        }

        case 'reorder': {
          if (!r || !r.ex) break;
          const order = Array.isArray(c.after) ? c.after : null;
          if (order) {
            const byId = new Map(r.ex.map(e => [e.id, e]));
            const next = order.map(id => byId.get(id)).filter(Boolean);
            if (next.length === r.ex.length) {
              r.ex = next;
            }
          }
          break;
        }

        case 'superset': {
          if (!r || !r.ex) break;
          const i = r.ex.findIndex(e => e.id === target.exId);
          if (i < 0) break;
          if (!c.after?.link) {
            delete r.ex[i].sg;
          } else {
            const withId = c.after?.with;
            const j = r.ex.findIndex(e => e.id === withId);
            if (j >= 0) {
              const [partner] = r.ex.splice(j, 1);
              const at = r.ex.findIndex(e => e.id === target.exId);
              r.ex.splice(at + 1, 0, partner);
              const tag = 'sg' + String(Date.now()).slice(-4);
              r.ex[at].sg = tag;
              r.ex[at + 1].sg = tag;
            }
          }
          break;
        }

        case 'add-routine': {
          const a = c.after || {};
          const exList = (Array.isArray(a.ex) ? a.ex : []).map(e => {
            ensureCustomRegistered(e.id, e.name);
            return {
              id: e.id,
              sets: e.sets ?? 3,
              mode: e.mode ?? 'reps',
              ...(e.mode === 'time' ? { sec: e.sec ?? 45 } : { reps: e.reps ?? 10 })
            };
          });
          const newRoutine = {
            id: a.id || ('r' + (plan.routines.length + 1)),
            name: a.name || 'Routine',
            emoji: a.emoji || '🏋️',
            ...(a.prog ? { prog: a.prog } : {}),
            ex: exList
          };
          plan.routines.push(newRoutine);
          break;
        }

        case 'remove-routine': {
          const id = target.routineId || c.targetRoutineId;
          if (id) {
            plan.routines = plan.routines.filter(rt => rt.id !== id);
            for (const d of Object.keys(plan.week)) {
              if (Array.isArray(plan.week[d])) {
                plan.week[d] = plan.week[d].filter(rid => rid !== id);
                if (plan.week[d].length === 0) delete plan.week[d];
              } else if (plan.week[d] === id) {
                delete plan.week[d];
              }
            }
          }
          break;
        }

        case 'rename-routine': {
          if (r && typeof c.after === 'string') {
            r.name = c.after;
          }
          break;
        }

        case 'week': {
          const d = target.weekday != null ? target.weekday : c.weekday;
          if (d != null) {
            const sessions = getSessions(c.after);
            if (sessions.length === 0 || c.after === 'rest') {
              delete plan.week[d];
            } else {
              plan.week[d] = sessions;
            }
          }
          break;
        }
      }
    }
  } else if (review?.routines) {
    if (Array.isArray(review.customEx)) {
      for (const c of review.customEx) {
        const cid = typeof c === 'string' ? c : c?.id;
        ensureCustomRegistered(cid, c?.n || c?.name);
      }
    }
    for (const r of review.routines) {
      for (const e of (r.ex || [])) {
        ensureCustomRegistered(e.id, e.name);
      }
      plan.routines.push({ ...r, ex: [...(r.ex || [])] });
    }
    if (review.week) {
      for (const [d, val] of Object.entries(review.week)) {
        const sessions = getSessions(val);
        if (sessions.length === 0 || val === 'rest') {
          delete plan.week[d];
        } else {
          plan.week[d] = sessions;
        }
      }
    }
  }

  return plan;
}
