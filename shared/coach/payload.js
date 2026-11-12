/* What actually leaves this server (or client in BYOK mode).
 *
 * The consent screen makes a promise about which categories of data reach the provider, and
 * this file is where that promise is either kept or quietly broken. So it is built as an
 * allowlist: every field is copied in by name. Nothing is spread, nothing is passed through,
 * and a field added to the state blob next year cannot ride along by accident — which is the
 * property the FR-11 test actually asserts.
 *
 * Excluded on purpose and permanently: the profile's display name and user id (an opaque
 * handle stands in), passkey and credential material, push subscriptions, invite data, theme
 * and appearance settings, and every other profile's everything.
 */
import { LIBRARY, LIB_BY_ID, libraryHas, libraryName } from './library.js';
import { modeOf, canonicalPlan } from './plan.js';

export const CONTRACT = 1;
// Bounds from FR-22. A review reads a training block, not a training career: more history
// makes the payload bigger and the reading vaguer, not better.
export const MAX_WEEKS = 12;
export const MAX_SESSIONS = 60;

/* ---------- the data categories the consent screen names (FR-09/10) ----------
   Kept here, next to the code that acts on it, and rendered by the consent UI from the same
   list — a screen that drifts from the payload is worse than no screen. */
export const DATA_CATEGORIES = [
  'plan',        // routines, exercises, sets/reps, schedule, progression settings
  'training',    // logged sets, targets, effort ratings, durations, PRs in the review window
  'bodyweight',  // weigh-ins in the window and your goal weight
  'profile',     // the intake answers you gave the Coach, including any limitations
  'prefs'        // unit, language, effort scale
];

/** Stable per-profile pseudonym fallback when no server-side HMAC is provided. */
function defaultHandle(uid) {
  if (!uid) return 'anonymous-lifter';
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const str = 'coach-handle:' + uid;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 3) | i & 7), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/* ---------- reading a session the way the engine reads it ----------
   Duplicated from frontend/src/lib/progression.js rather than shared: the two runtimes have
   no build step in common, and this is the same trade-off server.js already made for
   effectiveRoutineId. coach.test.js pins the two implementations against shared fixtures so
   the copy cannot drift silently. */
function readSession(entry, fallback) {
  const target = (entry && entry.target) || fallback || {};
  const mode = modeOf(target, LIB_BY_ID.get(entry?.id));
  const sets = (entry && entry.sets) || [];
  const planned = target.sets || sets.length;
  const enough = sets.length >= planned;
  if (mode === 'time') {
    const goal = target.sec || 0;
    const held = sets.map(s => (s.done ? (s.sec || 0) : 0));
    return { mode, goal, ok: goal > 0 && enough && held.length > 0 && held.every(h => h >= goal) };
  }
  const goal = target.reps || 0;
  const reps = sets.map(s => (s.done ? (s.r || 0) : 0));
  return { mode, goal, ok: goal > 0 && enough && reps.length > 0 && reps.every(r => r >= goal) };
}
/** Consecutive misses counting back from the most recent session. */
export function stallCount(sessions) {
  let n = 0;
  for (let i = sessions.length - 1; i >= 0; i--) { if (sessions[i].ok) break; n++; }
  return n;
}

/* ---------- plan cleaning (mirrors plan-share.js cleanEx) ---------- */
function cleanEx(e) {
  const o = { id: e.id, name: LIB_BY_ID.get(e.id)?.n || null, sets: e.sets };
  const mode = modeOf(e, LIB_BY_ID.get(e.id));
  o.mode = mode;
  if (mode === 'cardio') { if (e.min != null) o.min = e.min; if (e.speed != null) o.speed = e.speed; }
  else if (mode === 'time') { if (e.sec != null) o.sec = e.sec; if (e.weight) o.weight = e.weight; }
  else { if (e.reps != null) o.reps = e.reps; if (e.weight) o.weight = e.weight; }
  if (e.prog) o.prog = e.prog;
  if (e.inc > 0) o.inc = e.inc;
  if (e.repsMin != null) o.repsMin = e.repsMin;
  if (e.sg) o.sg = e.sg;
  return o;
}

export function cleanPlan(S) {
  const routines = (S?.routines || []).map(r => ({
    id: r.id, name: r.name, emoji: r.emoji, ...(r.prog ? { prog: r.prog } : {}), ex: (r.ex || []).map(cleanEx)
  }));
  const week = {};
  [1, 2, 3, 4, 5, 6, 0].forEach(d => { if (S?.week?.[d]) week[d] = S.week[d]; });
  return { routines, week };
}

/* ---------- the library slice the model gets to choose from ---------- */
export const VALID_MODALITIES = ['strength', 'yoga', 'stretching', 'plyometrics', 'cardio'];

/**
 * Determine the modality/category tag of an exercise.
 * Defaults to 'strength' when absent.
 */
export function exerciseCategory(e) {
  if (e?.cat) return String(e.cat).toLowerCase().trim();
  if (e?.category) return String(e.category).toLowerCase().trim();
  if (e?.id && String(e.id).startsWith('yoga-')) return 'yoga';
  if (e?.bp === 'cardio') return 'cardio';
  const id = String(e?.id || '');
  const n = String(e?.n || '').toLowerCase();
  if (id.startsWith('fedb-')) {
    const plyoWords = ['jump', 'bound', 'hop', 'swing', 'throw', 'sprint', 'hurdle', 'skier', 'tuck', 'toss', 'skip', 'leap', 'bounding', 'drop', 'slap', 'drill', 'push', 'step', 'thrust', 'kick', 'squeeze'];
    if (plyoWords.some(w => n.includes(w))) return 'plyometrics';
    return 'stretching';
  }
  if (n.includes('stretch')) return 'stretching';
  return 'strength';
}

/**
 * Extract target modalities from explicit argument or state S (intake/profile/plan/active).
 * Defaults to ['strength'] when none are specified.
 */
export function extractModalities(S, modalities) {
  const mods = new Set();
  const add = (val) => {
    if (!val) return;
    if (Array.isArray(val)) {
      val.forEach(v => add(v));
    } else if (typeof val === 'string') {
      val.split(/[,+]/).map(s => s.trim().toLowerCase()).filter(Boolean).forEach(m => mods.add(m));
    }
  };

  if (modalities) {
    add(modalities);
  }
  if (mods.size === 0 && S) {
    add(S.modalities);
    add(S.modality);
    add(S.plan?.modalities);
    add(S.plan?.modality);
    add(S.coach?.profile?.modalities);
    add(S.coach?.profile?.modality);
    add(S.profile?.modalities);
    add(S.profile?.modality);
    add(S.intake?.modalities);
    add(S.intake?.modality);

    // Active session modalities
    if (S.active) {
      add(S.active.modality);
      add(S.active.modalities);
      (S.active.entries || []).forEach(en => {
        if (en?.id) {
          const ex = LIB_BY_ID.get(en.id) || (S.customEx || []).find(c => c.id === en.id);
          if (ex) add(exerciseCategory(ex));
        }
      });
    }

    // Plan routines modalities
    (S.routines || []).forEach(r => {
      add(r.modality);
      add(r.modalities);
      add(r.cat);
      add(r.category);
      (r.ex || []).forEach(e => {
        add(e.modality);
        add(e.cat);
        add(e.category);
        if (e.id) {
          const ex = LIB_BY_ID.get(e.id) || (S.customEx || []).find(c => c.id === e.id);
          if (ex) add(exerciseCategory(ex));
        }
      });
    });
  }

  if (mods.size === 0) {
    return ['strength'];
  }
  return Array.from(mods);
}

export function librarySlice(S, equipment, modalities) {
  let equip = equipment;
  let mods = modalities;
  if (equipment && typeof equipment === 'object' && !Array.isArray(equipment)) {
    equip = equipment.equipment;
    mods = equipment.modalities ?? modalities;
  }

  const wantedEquip = (Array.isArray(equip) ? equip : equip ? [equip] : []).map(x => String(x).toLowerCase().trim()).filter(Boolean);
  const targetMods = extractModalities(S, mods);

  // Filter customs by modality (customs without category default to 'strength')
  const customs = (S?.customEx || [])
    .filter(c => targetMods.includes(exerciseCategory(c)))
    .map(c => ({ id: c.id, n: c.n, bp: c.bp, tg: null, eq: 'custom', custom: true, ...(c.cat ? { cat: c.cat } : c.category ? { category: c.category } : {}) }));

  // 1. Modality pool
  let modPool = LIBRARY.filter(e => targetMods.includes(exerciseCategory(e)));
  if (!modPool.length) {
    modPool = LIBRARY.filter(e => exerciseCategory(e) === 'strength');
    if (!modPool.length) modPool = LIBRARY;
  }

  // 2. Equipment filter on modality pool
  // No equipment stated (or "everything") ⇒ the whole modality catalogue.
  let base = wantedEquip.length ? modPool.filter(e => wantedEquip.includes((e.eq || '').toLowerCase())) : modPool;

  // Fallback if equipment nobody has yields 0 matches
  if (!base.length) {
    base = modPool.length ? modPool : LIBRARY;
  }

  return [...customs, ...base];
}
export { libraryHas, libraryName, LIBRARY, canonicalPlan };

/* ---------- effort scale (mirrors history.js effortOf) ---------- */
const effortOf = S => {
  const e = S && S.effort;
  return e === 'none' || e === 'rir' || e === 'rpe' ? e : (S && S.showRir ? 'rir' : 'none');
};

/* ---------- window + aggregates ---------- */
const iso = d => d.toISOString().slice(0, 10);

export function reviewWindow(S, since) {
  const all = (S?.workouts || []).filter(w => w && w.d);
  const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - MAX_WEEKS * 7);
  const cutoff = iso(cutoffDate);
  const from = since && since > cutoff ? since : cutoff;
  return all.filter(w => w.d >= from).slice(-MAX_SESSIONS);
}

function aggregates(S, workouts) {
  // Per-exercise stall/deload picture, computed over the same sessions the engine would see.
  const byEx = new Map();
  const planCfg = new Map();
  (S?.routines || []).forEach(r => (r.ex || []).forEach(e => planCfg.set(e.id, e)));
  (S?.workouts || []).forEach(w => (w.entries || []).forEach(en => {
    if (!en.sets?.some(s => s.done)) return;
    if (!byEx.has(en.id)) byEx.set(en.id, []);
    byEx.get(en.id).push(readSession(en, planCfg.get(en.id)));
  }));
  const exercises = [];
  for (const [id, sessions] of byEx) {
    const stalls = stallCount(sessions);
    if (stalls > 0 || sessions.length >= 3) {
      exercises.push({ id, name: libraryName(id), sessions: sessions.length, stalls, lastOk: !!sessions[sessions.length - 1]?.ok });
    }
  }

  // Adherence: what the week asked for against what actually happened.
  const trained = new Set(workouts.map(w => w.d));
  const plannedDays = Object.keys(S?.week || {}).filter(k => S.week[k]).length;
  const reschedules = Object.entries(S?.dayPlan || {}).filter(([d]) => workouts.some(w => w.d === d) || d >= (workouts[0]?.d || '')).length;

  // Muscle coverage in the window, by body part — the "not trained" gap the Stats screen shows.
  const hit = {};
  workouts.forEach(w => (w.entries || []).forEach(en => {
    if (!en.sets?.some(s => s.done)) return;
    const bp = LIB_BY_ID.get(en.id)?.bp;
    if (bp) hit[bp] = (hit[bp] || 0) + en.sets.filter(s => s.done).length;
  }));

  const durations = workouts.map(w => (w.end && w.start ? Math.round((w.end - w.start) / 60000) : null)).filter(Boolean);
  return {
    exercises,
    adherence: { plannedPerWeek: plannedDays, sessionsInWindow: workouts.length, distinctDays: trained.size, dayOverrides: reschedules },
    setsByBodyPart: hit,
    sessionMinutes: durations.length
      ? { median: durations.slice().sort((a, b) => a - b)[Math.floor(durations.length / 2)], min: Math.min(...durations), max: Math.max(...durations) }
      : null
  };
}

/** One workout, reduced to what a coach reads. */
function cleanWorkout(w) {
  return {
    d: w.d,
    name: w.name || null,
    minutes: w.end && w.start ? Math.round((w.end - w.start) / 60000) : null,
    ...(w.rating ? { rating: w.rating } : {}),
    ...(w.note ? { note: String(w.note).slice(0, 300) } : {}),
    prs: (w.prs || []).length,
    entries: (w.entries || []).map(en => ({
      id: en.id,
      name: libraryName(en.id),
      target: en.target ? { sets: en.target.sets, reps: en.target.reps, sec: en.target.sec, weight: en.target.weight } : null,
      sets: (en.sets || []).map(s => {
        const o = { done: !!s.done };
        if (s.w != null) o.w = s.w;
        if (s.r != null) o.r = s.r;
        if (s.sec != null) o.sec = s.sec;
        if (s.min != null) o.min = s.min;
        if (s.speed != null) o.speed = s.speed;
        if (s.rir != null) o.rir = s.rir;
        if (s.rpe != null) o.rpe = s.rpe;
        return o;
      })
    }))
  };
}

/* ---------- cardio volume summary & training load (ACWR) (Issue #69) ---------- */

function cardioDate(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.d === 'string' && c.d.length >= 10) return c.d.slice(0, 10);
  if (typeof c.date === 'string' && c.date.length >= 10) return c.date.slice(0, 10);
  if (c.startTime) {
    if (typeof c.startTime === 'string' && c.startTime.length >= 10) {
      const s = c.startTime.slice(0, 10);
      if (!isNaN(new Date(s).getTime())) return s;
    }
    const dt = new Date(c.startTime);
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  if (c.start) {
    const dt = new Date(c.start);
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  return null;
}

function getDistanceM(c) {
  if (!c || typeof c !== 'object') return 0;
  let val = 0;
  if (typeof c.distanceM === 'number') val = c.distanceM;
  else if (typeof c.distance === 'number') val = c.distance;
  else if (typeof c.dist === 'number') val = c.dist;
  else if (typeof c.distanceKm === 'number') val = c.distanceKm * 1000;
  else if (typeof c.miles === 'number') val = c.miles * 1609.344;
  else if (typeof c.distanceM === 'string' && !isNaN(Number(c.distanceM))) val = Number(c.distanceM);
  else if (typeof c.distance === 'string' && !isNaN(Number(c.distance))) val = Number(c.distance);
  if (!isFinite(val) || isNaN(val) || val <= 0) return 0;
  return val;
}

function getDurationMs(c) {
  if (!c || typeof c !== 'object') return 0;
  let ms = 0;
  if (typeof c.durationMs === 'number') ms = c.durationMs;
  else if (typeof c.duration === 'number') {
    ms = c.duration > 86400 ? c.duration : c.duration * 1000;
  } else if (c.end && c.start && isFinite(c.end) && isFinite(c.start) && c.end > c.start) {
    ms = c.end - c.start;
  } else if (typeof c.durationMin === 'number') ms = c.durationMin * 60000;
  else if (typeof c.min === 'number') ms = c.min * 60000;
  else if (typeof c.durationMs === 'string' && !isNaN(Number(c.durationMs))) ms = Number(c.durationMs);
  if (!isFinite(ms) || isNaN(ms) || ms <= 0) return 0;
  return ms;
}

function getRpe(c) {
  if (!c || typeof c !== 'object') return 6;
  let r = null;
  if (typeof c.rpe === 'number') r = c.rpe;
  else if (typeof c.rpe === 'string' && !isNaN(Number(c.rpe))) r = Number(c.rpe);
  if (r == null || !isFinite(r) || isNaN(r) || r <= 0) return 6;
  return Math.min(10, Math.max(1, r));
}

export function acwrRiskCategory(acwr) {
  const v = Number(acwr);
  if (!isFinite(v) || isNaN(v) || v < 0.8) return 'undertraining';
  if (v <= 1.3) return 'optimal';
  if (v <= 1.5) return 'caution';
  return 'danger';
}

export function computeCardioSummaryAndLoad(cardioActivities, opts = {}) {
  const activities = Array.isArray(cardioActivities) ? cardioActivities : [];

  let endDt = null;
  if (opts.endDate || opts.today || opts.now) {
    const raw = opts.endDate || opts.today || opts.now;
    endDt = new Date(typeof raw === 'string' && raw.length === 10 ? raw + 'T12:00:00' : raw);
  }
  if (!endDt || isNaN(endDt.getTime())) {
    let maxTs = 0;
    for (const item of activities) {
      const dStr = cardioDate(item);
      if (dStr) {
        const t = new Date(dStr + 'T12:00:00').getTime();
        if (!isNaN(t) && t > maxTs) maxTs = t;
      }
    }
    const now = new Date();
    if (maxTs > 0 && now.getTime() - maxTs > 90 * 86400000 && !opts.anchorToToday) {
      endDt = new Date(maxTs);
    } else {
      endDt = now;
    }
  }

  const dateStrings = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(endDt);
    d.setDate(d.getDate() - i);
    dateStrings.push(d.toISOString().slice(0, 10));
  }

  const dateSet7 = new Set(dateStrings.slice(-7));
  const dateSet28 = new Set(dateStrings);
  const dailyLoads = new Map(dateStrings.map(ds => [ds, 0]));

  let distM7 = 0, durMs7 = 0, count7 = 0;
  let distM28 = 0, durMs28 = 0, count28 = 0;

  for (const c of activities) {
    const ds = cardioDate(c);
    if (!ds) continue;

    const distM = getDistanceM(c);
    const durMs = getDurationMs(c);
    const rpe = getRpe(c);
    const durMin = durMs / 60000;
    const sessionLoad = Math.round(durMin * rpe * 100) / 100;

    if (dateSet28.has(ds)) {
      distM28 += distM;
      durMs28 += durMs;
      count28++;
      dailyLoads.set(ds, (dailyLoads.get(ds) || 0) + sessionLoad);
    }
    if (dateSet7.has(ds)) {
      distM7 += distM;
      durMs7 += durMs;
      count7++;
    }
  }

  const loadArray = dateStrings.map(ds => dailyLoads.get(ds) || 0);
  const acuteWindow = loadArray.slice(-7);
  const chronicWindow = loadArray.slice(-28);

  const acuteTotal = acuteWindow.reduce((s, v) => s + v, 0);
  const chronicTotal = chronicWindow.reduce((s, v) => s + v, 0);

  const acuteDaily = acuteTotal / 7;
  const chronicDaily = chronicTotal / 28;

  let acwr = 0;
  if (chronicDaily > 0) {
    acwr = acuteDaily / chronicDaily;
  } else if (acuteDaily > 0) {
    acwr = 2.0;
  } else {
    acwr = 0;
  }
  if (!isFinite(acwr) || isNaN(acwr)) acwr = 0;

  const roundedAcwr = Math.round(acwr * 100) / 100;
  const riskCategory = acwrRiskCategory(roundedAcwr);

  const formatSummary = (distM, durMs, count) => {
    const km = Math.round((distM / 1000) * 100) / 100;
    const miles = Math.round((distM / 1609.344) * 100) / 100;
    const durMin = Math.round((durMs / 60000) * 10) / 10;
    const hrs = Math.floor(durMin / 60);
    const mins = Math.round(durMin % 60);
    const durFormatted = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    return {
      distanceM: distM,
      distanceKm: km,
      distanceMiles: miles,
      mileage: miles,
      km,
      miles,
      durationMs: durMs,
      durationMin: durMin,
      durationFormatted: durFormatted,
      duration: durFormatted,
      count,
      activities: count
    };
  };

  const summary7d = formatSummary(distM7, durMs7, count7);
  const summary28d = formatSummary(distM28, durMs28, count28);

  return {
    summary7d,
    summary28d,
    last7d: summary7d,
    last28d: summary28d,
    volume: {
      summary7d,
      summary28d,
      last7d: summary7d,
      last28d: summary28d
    },
    acuteLoad: Math.round(acuteDaily * 10) / 10,
    chronicLoad: Math.round(chronicDaily * 10) / 10,
    acuteTotal: Math.round(acuteTotal * 10) / 10,
    chronicTotal: Math.round(chronicTotal * 10) / 10,
    acwr: roundedAcwr,
    ratio: roundedAcwr,
    riskCategory,
    riskZone: riskCategory
  };
}

export const computeCardioSummary = computeCardioSummaryAndLoad;

/**
 * Build a job payload.
 *
 * @param {object} S      the profile's synced state, as read from disk or memory
 * @param {string} uid    used to derive the opaque handle
 * @param {object} opts   { kind, intake?, note?, refine?, previous?, handle? }
 */
export function build(S, uid, opts = {}) {
  if (uid && typeof uid === 'object' && Object.keys(opts).length === 0) {
    opts = uid;
    uid = null;
  }
  const coach = S?.coach || {};
  const profile = opts.intake || coach.profile || null;
  const p = {
    coach_contract: CONTRACT,
    task: opts.kind === 'review' ? 'review' : 'create',
    meta: {
      profile: opts.handle || defaultHandle(uid),
      lang: S?.lang || 'en',
      unit: S?.unit || 'kg',
      effortScale: effortOf(S),
      today: iso(new Date())
    },
    coachProfile: profile ? {
      goal: profile.goal || (Array.isArray(profile.goals) && profile.goals.length ? profile.goals[0] : null),
      goals: Array.isArray(profile.goals) ? profile.goals : (profile.goal ? [profile.goal] : []),
      experience: profile.experience || null,
      daysPerWeek: profile.daysPerWeek || null,
      preferredDays: profile.preferredDays || [],
      sessionMin: profile.sessionMin || null,
      equipment: profile.equipment || [],
      limitations: profile.limitations || '',
      likes: profile.likes || '',
      dislikes: profile.dislikes || '',
      notes: profile.notes || '',
      demographics: (profile.demographics && typeof profile.demographics === 'object') ? {
        age: profile.demographics.age ?? null,
        sex: profile.demographics.sex ?? null,
        weight: profile.demographics.weight ?? null,
        height: profile.demographics.height ?? null,
      } : (profile.age != null || profile.sex != null || profile.weight != null || profile.height != null) ? {
        age: profile.age ?? null,
        sex: profile.sex ?? null,
        weight: profile.weight ?? null,
        height: profile.height ?? null,
      } : null,
      targetEvent: (profile.targetEvent && typeof profile.targetEvent === 'object') ? {
        date: profile.targetEvent.date || null,
        kind: profile.targetEvent.kind || null,
        phase: profile.targetEvent.phase || null,
      } : (profile.targetEventDate || profile.targetEventKind || profile.targetEventPhase) ? {
        date: profile.targetEventDate || null,
        kind: profile.targetEventKind || null,
        phase: profile.targetEventPhase || null,
      } : null,
      ...(profile.modalities ? { modalities: profile.modalities } : profile.modality ? { modalities: [profile.modality] } : {})
    } : null,
    plan: cleanPlan(S)
  };

  const cardio = computeCardioSummaryAndLoad(S?.cardioActivities, opts);
  p.cardio = cardio;
  p.trainingLoad = {
    acuteLoad: cardio.acuteLoad,
    chronicLoad: cardio.chronicLoad,
    acwr: cardio.acwr,
    riskCategory: cardio.riskCategory,
    riskZone: cardio.riskZone
  };
  p.cardioVolume = cardio.volume;

  // What the user already turned down, so the Coach does not re-propose it without new
  // evidence (FR-26). Summaries only — the log's full before/after stays on the device.
  const declined = (coach.log || [])
    .flatMap(e => (e.decisions || []).filter(d => d.status === 'rejected').map(d => ({ type: d.type, why: d.why })))
    .slice(-15);
  if (declined.length) p.previouslyDeclined = declined;

  const activeModalities = opts.modalities || opts.intake?.modalities || profile?.modalities || opts.modality || profile?.modality;

  if (opts.kind === 'review') {
    const workouts = reviewWindow(S, coach.lastReview?.at ? String(coach.lastReview.at).slice(0, 10) : null);
    p.window = {
      from: workouts[0]?.d || null,
      to: workouts[workouts.length - 1]?.d || null,
      workouts: workouts.map(cleanWorkout)
    };
    p.aggregates = aggregates(S, workouts);
    p.aggregates.cardio = cardio;
    p.bodyweight = {
      goal: S?.targetW ?? null,
      series: (S?.bodyweight || []).filter(b => !p.window.from || b.d >= p.window.from).map(b => ({ d: b.d, w: b.w }))
    };
    if (opts.note) p.userNote = String(opts.note).slice(0, 1000);
    p.library = librarySlice(S, profile?.equipment, activeModalities);
  } else {
    p.library = librarySlice(S, profile?.equipment, activeModalities);
    // Creation for a returning user: what they have actually handled, so proposed baselines
    // start from evidence rather than optimism (B2/FR-20).
    const best = {};
    (S?.workouts || []).forEach(w => (w.entries || []).forEach(en => en.sets?.forEach(s => {
      if (s.done && s.w > 0) best[en.id] = Math.max(best[en.id] || 0, s.w);
    })));
    if (Object.keys(best).length) {
      p.history = {
        sessions: (S?.workouts || []).length,
        since: (S?.workouts || [])[0]?.d || null,
        workingWeights: Object.entries(best).map(([id, w]) => ({ id, name: libraryName(id), best: w }))
      };
    }
    if (opts.refine) {
      p.refine = { text: String(opts.refine).slice(0, 1000), previous: opts.previous || null };
    }
  }
  return p;
}
