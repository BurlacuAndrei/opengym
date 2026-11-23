// Pure helpers over the state object S (ported 1:1 from the vanilla app).
import { todayISO, isoOf, weekKey, fmtNum } from './format.js'
import { isCardio } from './exercises.js'
import { getRoutineKind, isRoutineKind } from './routine-kind.js'
import { getCardioPlans } from './cardio-plan.js'

const FLOW_KINDS = new Set(['hiit', 'yoga', 'mobility'])
const isRestToken = id => id === 'rest' || id === '__rest__'

function toIdList(val) {
  if (Array.isArray(val)) return val.filter(x => typeof x === 'string' && x.trim() !== '').map(x => x.trim())
  if (typeof val === 'string' && val.trim() !== '') return [val.trim()]
  return []
}

function dedupById(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (!item || !item.id || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

function parseValidISO(val) {
  if (val == null || val === '') return null
  if (typeof val === 'string') {
    const s = val.trim()
    if (!s) return null
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (m) {
      const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
      const dt = new Date(y, mo - 1, d)
      if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) {
        return `${m[1]}-${m[2]}-${m[3]}`
      }
      return null
    }
    const dt = new Date(s)
    return !isNaN(dt.getTime()) ? isoOf(dt) : null
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return null
    const dt = new Date(val)
    return !isNaN(dt.getTime()) ? isoOf(dt) : null
  }
  if (val instanceof Date) {
    return !isNaN(val.getTime()) ? isoOf(val) : null
  }
  return null
}

function extractEntryISO(entry) {
  if (!entry || typeof entry !== 'object') return null
  return (
    parseValidISO(entry.d) ||
    parseValidISO(entry.date) ||
    parseValidISO(entry.startTime) ||
    parseValidISO(entry.start) ||
    parseValidISO(entry.completedAt)
  )
}

function extractEntryTs(entry, iso) {
  if (entry && typeof entry === 'object') {
    for (const v of [entry.start, entry.startTime, entry.completedAt, entry.createdAt]) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
      if (typeof v === 'string' && v.trim()) {
        const ts = new Date(v).getTime()
        if (Number.isFinite(ts)) return ts
      }
    }
  }
  if (iso) {
    const ts = new Date(iso + 'T12:00:00').getTime()
    if (Number.isFinite(ts)) return ts
  }
  return 0
}

// How an exercise is logged (issue #16). This used to be derived from the body part alone,
// which meant a plank or a farmer's carry could only be timed by filing it under cardio.
// A routine entry can now say so explicitly:
//   reps   — weight × reps      sets look like { w, r }
//   time   — a work duration    sets look like { sec, w }   (w = 0 for bodyweight)
//   cardio — duration + speed   sets look like { min, speed }
// An entry without `mode` behaves exactly as before, so every existing plan, workout and
// plan file is read unchanged and nothing needs migrating.
export function modeOf(cfg) {
  const m = cfg && cfg.mode
  if (m === 'reps' || m === 'time' || m === 'cardio') return m
  return isCardio(cfg && cfg.id) ? 'cardio' : 'reps'
}
export const isTimed = cfg => modeOf(cfg) === 'time'

// mm:ss for a work duration — seconds alone read badly past a minute ("90 s" vs "1:30").
export function fmtSec(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0')
}

// How hard a set felt, if the profile logs it at all. Two scales for the same thing, kept in
// their own fields: RIR counts the reps still in the tank, RPE reads the same effort off a
// 10-point scale from the top (RPE 8 ≈ RIR 2). A set logged on one scale is never silently
// rewritten as the other — switching the setting changes what new sets ask for, nothing else.
// `min`..`max` is the range the stepper walks. RIR bottoms out at 0 (a set taken to failure);
// RPE bottoms out at 6, since the scale is only meaningful for working sets and anything
// lighter is a warm-up nobody rates.
export const EFFORT = {
  rir: { f: 'rir', hd: 'RIR', step: 0.5, min: 0, max: 10 },
  rpe: { f: 'rpe', hd: 'RPE', step: 0.5, min: 6, max: 10 }
}
// One tap of an effort stepper. Empty is not 0 — an unlogged effort must not become "went to
// failure" from one stray tap — so − on an empty cell leaves it empty, and + starts at the
// bottom of the scale and walks up from there in even steps. Stepping back off the bottom
// clears the cell again, so a mistap is undoable. null means "nothing logged"; the caller
// stores that by dropping the key rather than writing a null.
export function stepEffort(kind, cur, dir) {
  const e = EFFORT[kind]
  if (!e) return cur ?? null
  if (cur == null) return dir < 0 ? null : e.min
  const n = Math.round((cur + dir * e.step) * 100) / 100
  if (dir < 0 && n < e.min) return null
  // only the ceiling is enforced on the way up: a value typed below the floor (nothing stops
  // someone entering RPE 3) still steps in even increments instead of snapping to the floor.
  return dir > 0 ? Math.min(e.max, n) : Math.max(e.min, n)
}
// A typed effort is capped but not floored — clamping up while someone types "10" would turn
// the first keystroke into the floor and fight the input.
export const capEffort = (kind, v) =>
  (v == null || !EFFORT[kind] ? v : Math.min(EFFORT[kind].max, v))
// Which scale a profile logs. `showRir` is the boolean this replaced and is only consulted
// when the profile has no answer of its own — an explicit 'none' has to win over it, or a
// backup or another device that still carries the old flag would switch the column back on.
export const effortOf = S => {
  const e = S && S.effort
  return e === 'none' || EFFORT[e] ? e : (S && S.showRir ? 'rir' : 'none')
}
// The "(RIR 2)" / "(RPE 8)" tail on a set summary, empty when nothing was logged.
const effortTail = s => {
  const k = s.rir != null ? 'rir' : s.rpe != null ? 'rpe' : null
  return k ? ` (${EFFORT[k].hd} ${fmtNum(s[k])})` : ''
}

// One-line summary of a logged set. `cfg` carries the mode when the caller has it (a routine
// entry or a workout entry); passing an id alone keeps the old body-part behaviour.
export function setLabel(id, s, cfg) {
  const mode = modeOf(cfg || { id })
  if (mode === 'cardio') return `${s.min || 0} min @ ${fmtNum(s.speed || 0)} km/h`
  if (mode === 'time') return fmtSec(s.sec) + (s.w > 0 ? ` · ${fmtNum(s.w)}` : '')
  return `${fmtNum(s.w || 0)}×${s.r || 0}` + effortTail(s)
}
// Default config for a freshly added exercise.
export function defaultConfig(id, mode) {
  const m = mode || modeOf({ id })
  if (m === 'cardio') return { sets: 1, min: 20, speed: 8 }
  if (m === 'time') return { sets: 3, sec: 45, weight: 0, mode: 'time' }
  return { sets: 3, reps: 10, weight: 0, mode: 'reps' }
}
// One-line summary of a planned exercise ("3 × 10 · 60 kg"), shared by the routine editor
// and the plan export so a mode is described the same way everywhere.
export function exLine(cfg, unit) {
  const mode = modeOf(cfg)
  const n = cfg.sets || 1
  const load = cfg.weight ? ' · ' + fmtNum(cfg.weight) + ' ' + unit : ''
  if (mode === 'cardio') return `${n} × ${cfg.min || 20} min @ ${fmtNum(cfg.speed || 8)} km/h`
  if (mode === 'time') return `${n} × ${fmtSec(cfg.sec || 45)}${load}`
  return `${n} × ${cfg.reps}${load}`
}

// Drop superset ids that no longer have an adjacent partner (after unlink/reorder/remove).
export function cleanupSg(ex) {
  ex.forEach((e, i) => {
    if (e.sg && !(ex[i - 1]?.sg === e.sg || ex[i + 1]?.sg === e.sg)) delete e.sg
  })
}

export function lastEntryFor(S, exId) {
  for (let i = S.workouts.length - 1; i >= 0; i--) {
    const en = S.workouts[i].entries.find(e => e.id === exId)
    // `target` is what the session prescribed; finished workouts carry it so labels and the
    // progression engine can read a session back the way it was logged. Older workouts have
    // none — modeOf() falls back to the body part for them, which is what they were.
    if (en && en.sets.some(s => s.done)) return { d: S.workouts[i].d, sets: en.sets.filter(s => s.done), target: en.target || null }
  }
  return null
}
export function bestWeightFor(S, exId) {
  let best = 0
  S.workouts.forEach(w => w.entries.forEach(e => {
    if (e.id === exId) {
      e.sets.forEach(s => { if (s.done && s.w > best) best = s.w })
      if (e.topW && e.topW > best) best = e.topW
    }
  }))
  return best
}
export function effectiveRoutineId(S, iso) {
  if (!S || !iso) return null
  const validIso = parseValidISO(iso)
  if (!validIso) return null
  const routines = Array.isArray(S.routines) ? S.routines.filter(Boolean) : []
  const ovRaw = toIdList(S.dayPlan?.[validIso])
  if (ovRaw.some(isRestToken)) return null
  if (ovRaw.length > 0) {
    const match = ovRaw.find(id => routines.some(r => r.id === id))
    return match || null
  }
  const wd = new Date(validIso + 'T12:00:00').getDay()
  const weekRaw = toIdList(S.week?.[wd])
  if (weekRaw.some(isRestToken)) return null
  if (weekRaw.length === 0) return null
  const match = weekRaw.find(id => routines.some(r => r.id === id))
  if (match) return match
  if (routines.length === 0) {
    const cardioIds = new Set(getCardioPlans(S).map(p => p?.id).filter(Boolean))
    return weekRaw.find(id => !cardioIds.has(id)) || null
  }
  return null
}
export function effectiveRoutine(S, iso) {
  const id = effectiveRoutineId(S, iso)
  return id ? S.routines.find(r => r.id === id) || null : null
}

/**
 * Resolves all planned and completed sessions for a given ISO date (Issue #92).
 *
 * @param {Object} S - Application state
 * @param {string} isoDate - Date string (YYYY-MM-DD)
 * @returns {{ routines: Array, cardioPlans: Array, completed: Array, isRest: boolean, isOverride: boolean }}
 */
export function effectiveDaySessions(S, isoDate) {
  const empty = { routines: [], cardioPlans: [], completed: [], isRest: false, isOverride: false }
  if (!S || typeof S !== 'object' || !isoDate) return empty

  const validIso = parseValidISO(isoDate)
  if (!validIso) return empty
  const wd = new Date(validIso + 'T12:00:00').getDay()

  const allRoutines = Array.isArray(S.routines) ? S.routines.filter(Boolean) : []
  const routineById = new Map(allRoutines.map(r => [r.id, r]))
  const allCardioPlans = getCardioPlans(S).filter(Boolean)
  const cardioPlanById = new Map(allCardioPlans.map(p => [p.id, p]))

  const rawOv = toIdList(S.dayPlan?.[validIso])
  const isOverride = rawOv.length > 0

  let routines = []
  let cardioPlans = []
  let isRest = false

  if (isOverride) {
    if (rawOv.some(isRestToken)) {
      isRest = true
    } else {
      const seenIds = new Set()
      for (const id of rawOv) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
        if (routineById.has(id)) routines.push(routineById.get(id))
        if (cardioPlanById.has(id)) cardioPlans.push(cardioPlanById.get(id))
      }
      for (const p of allCardioPlans) {
        if (p.date === validIso) cardioPlans.push(p)
      }
      cardioPlans = dedupById(cardioPlans)
    }
  } else {
    const rawWeek = toIdList(S.week?.[wd])
    if (rawWeek.some(isRestToken)) {
      isRest = true
      cardioPlans = dedupById(allCardioPlans.filter(p => p.date === validIso))
    } else {
      const seenIds = new Set()
      for (const id of rawWeek) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
        if (routineById.has(id)) routines.push(routineById.get(id))
        if (cardioPlanById.has(id)) cardioPlans.push(cardioPlanById.get(id))
      }
      for (const p of allCardioPlans) {
        if (p.date === validIso || p.day === wd) {
          cardioPlans.push(p)
        }
      }
      cardioPlans = dedupById(cardioPlans)
    }
  }

  const completed = buildUnifiedEntries(S, { fallbackToday: false }).filter(item => item.d === validIso)

  return { routines, cardioPlans, completed, isRest, isOverride }
}
export function buildSets(S, cfg) {
  const last = lastEntryFor(S, cfg.id)
  const n = Math.max(1, cfg.sets || 1)
  const mode = modeOf(cfg)
  const sets = []
  // Last time's set at the same position, falling back to its final set when the plan grew.
  const prevAt = i => (last ? (last.sets[i] || last.sets[last.sets.length - 1]) : null)

  if (mode === 'cardio') {
    for (let i = 0; i < n; i++) {
      const prev = prevAt(i)
      sets.push({ min: prev ? prev.min : (cfg.min || 20), speed: prev ? prev.speed : (cfg.speed || 8), done: false })
    }
    return sets
  }
  if (mode === 'time') {
    for (let i = 0; i < n; i++) {
      // Only carry a previous value over when it came from a timed set — switching an
      // exercise from reps to time must not seed the duration from a rep count.
      const prev = prevAt(i)
      const carried = prev && prev.sec > 0 ? prev : null
      sets.push({ sec: carried ? carried.sec : (cfg.sec || 45), w: carried ? (carried.w || 0) : (cfg.weight || 0), done: false })
    }
    return sets
  }
  const conf = S.exWeights[cfg.id]
  for (let i = 0; i < n; i++) {
    const prev = prevAt(i)
    const usable = prev && prev.r > 0 ? prev : null
    const w = conf && conf.w > 0 ? conf.w : (usable ? usable.w : cfg.weight)
    sets.push({ w, r: usable ? usable.r : cfg.reps, done: false })
  }
  return sets
}
export function workoutVolume(w) {
  let v = 0
  w.entries.forEach(e => e.sets.forEach(s => { if (s.done) v += (s.w || 0) * (s.r || 0) }))
  return v
}
export function setsDone(w) {
  let n = 0
  ;(w?.entries || []).forEach(e => (e?.sets || []).forEach(s => { if (s?.done) n++ }))
  return n
}
export function setsDoneActive(A) {
  let n = 0
  if (A) A.entries.forEach(e => e.sets.forEach(s => { if (s.done) n++ }))
  return n
}
export const lastBW = S => (S.bodyweight.length ? S.bodyweight[S.bodyweight.length - 1] : null)

// Group consecutive items sharing a superset id (sg) into "units" of indices.
// items may be routine exercises ({sg}) or active-workout entries ({sg}).
export function supersetUnits(items) {
  const units = []
  items.forEach((e, i) => {
    const prev = items[i - 1]
    if (i > 0 && e.sg && prev && prev.sg && e.sg === prev.sg) units[units.length - 1].push(i)
    else units.push([i])
  })
  return units
}
export function unitOf(units, idx) { return units.find(u => u.includes(idx)) || [idx] }

export function streakWeeks(S) {
  const workouts = Array.isArray(S?.workouts) ? S.workouts : []
  const cardios = Array.isArray(S?.cardioActivities) ? S.cardioActivities : []
  const freestyles = Array.isArray(S?.freestyleSessions) ? S.freestyleSessions : []
  if (!workouts.length && !cardios.length && !freestyles.length) return 0
  const weeks = new Set()
  for (const entry of [...workouts, ...cardios, ...freestyles]) {
    const iso = extractEntryISO(entry)
    if (iso) weeks.add(weekKey(iso))
  }
  if (!weeks.size) return 0
  let streak = 0
  const cur = new Date()
  for (let i = 0; i < 520; i++) {
    const wk = weekKey(isoOf(cur))
    if (weeks.has(wk)) streak++
    else if (i > 0) break
    cur.setDate(cur.getDate() - 7)
  }
  return streak
}

function buildUnifiedEntries(S, { fallbackToday = true } = {}) {
  if (!S || typeof S !== 'object') return []
  const routines = Array.isArray(S.routines) ? S.routines : []
  const routineById = new Map(routines.filter(Boolean).map(r => [r.id, r]))
  const items = []

  const workouts = Array.isArray(S.workouts) ? S.workouts : []
  for (const w of workouts) {
    if (!w || typeof w !== 'object') continue
    const rawD = extractEntryISO(w) || parseValidISO(w.createdAt)
    const d = rawD || (fallbackToday ? todayISO() : null)
    const ts = extractEntryTs(w, d)
    const routine = w.routineId ? routineById.get(w.routineId) : null
    const kind = (w.kind && isRoutineKind(w.kind)) ? w.kind : getRoutineKind(routine || w)
    const pillar = FLOW_KINDS.has(kind) ? 'flow' : 'strength'
    items.push({
      ...w,
      entryType: 'workout',
      type: 'workout',
      kind,
      pillar,
      d,
      date: d,
      _ts: ts
    })
  }

  const cardios = Array.isArray(S.cardioActivities) ? S.cardioActivities : []
  for (const c of cardios) {
    if (!c || typeof c !== 'object') continue
    const rawD = extractEntryISO(c) || parseValidISO(c.createdAt)
    const d = rawD || (fallbackToday ? todayISO() : null)
    const ts = extractEntryTs(c, d)
    items.push({
      ...c,
      entryType: 'cardio',
      type: 'cardio',
      cardioType: c.type || 'run',
      sport: c.type || 'run',
      pillar: 'cardio',
      d,
      date: d,
      _ts: ts
    })
  }

  const freestyles = Array.isArray(S.freestyleSessions) ? S.freestyleSessions : []
  for (const f of freestyles) {
    if (!f || typeof f !== 'object') continue
    const rawD = extractEntryISO(f) || parseValidISO(f.createdAt)
    const d = rawD || (fallbackToday ? todayISO() : null)
    const ts = extractEntryTs(f, d)
    const kind = f.kind != null ? String(f.kind).trim().toLowerCase() : ''
    const pillar = FLOW_KINDS.has(kind) ? 'flow' : 'freestyle'
    items.push({
      ...f,
      entryType: 'freestyle',
      type: 'freestyle',
      kind,
      pillar,
      d,
      date: d,
      _ts: ts
    })
  }

  // Sort descending by date first, then timestamp within the same date
  items.sort((a, b) => {
    const dComp = (b.d || '').localeCompare(a.d || '')
    if (dComp !== 0) return dComp
    return (b._ts || 0) - (a._ts || 0)
  })

  return items
}

/**
 * Unified history helper: merges workouts, cardio activities, and freestyle sessions
 * into a single list sorted by date descending (newest first).
 *
 * Supports entry types: 'workout' | 'cardio' | 'freestyle'
 * Supports pillars: 'strength' | 'cardio' | 'flow' | 'freestyle'
 *
 * @param {Object} S - Application state
 * @param {string|Object} [filterOrOpts='all'] - Filter ('all' | 'workout' | 'strength' | 'cardio' | 'flow') or options object
 * @returns {Array<Object>} Sorted unified history entries
 */
export function unifiedHistory(S, filterOrOpts = 'all') {
  if (!S) return []
  const rawFilter = typeof filterOrOpts === 'string' ? filterOrOpts : (filterOrOpts?.filter || 'all')
  const filter = String(rawFilter || 'all').toLowerCase()

  let items = buildUnifiedEntries(S, { fallbackToday: true })

  if (filter === 'strength' || filter === 'workout') {
    items = items.filter(item => item.pillar === 'strength')
  } else if (filter === 'cardio') {
    items = items.filter(item => item.pillar === 'cardio')
  } else if (filter === 'flow') {
    items = items.filter(item => item.pillar === 'flow' || item.pillar === 'freestyle')
  } else if (filter === 'freestyle') {
    items = items.filter(item => item.entryType === 'freestyle')
  }

  if (typeof filterOrOpts === 'object' && filterOrOpts?.limit && filterOrOpts.limit > 0) {
    return items.slice(0, filterOrOpts.limit)
  }

  return items
}

export const getUnifiedHistory = unifiedHistory

/**
 * Groups an array of history items (or state S) by date string (YYYY-MM-DD).
 *
 * @param {Array<Object>|Object} itemsOrS - Array of unified items or state object S
 * @returns {Object} Map of ISO date string to array of history items
 */
export function groupHistoryByDate(itemsOrS) {
  const items = Array.isArray(itemsOrS) ? itemsOrS : unifiedHistory(itemsOrS)
  const map = {}
  for (const item of items) {
    const d = item.d || item.date
    if (!d) continue
    if (!map[d]) map[d] = []
    map[d].push(item)
  }
  return map
}

