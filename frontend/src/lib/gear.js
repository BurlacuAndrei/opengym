// Shoe & bike gear mileage tracker (Issue #54)
// Tracks distance accumulated on shoes and bikes, with retirement alerts at thresholds.
import { uid } from './format.js'

/**
 * Default mileage retirement thresholds in meters:
 * - Shoes: 800,000 meters (~500 miles / ~800 km)
 * - Bikes: 5,000,000 meters (~3,000 miles / ~5,000 km)
 */
export const DEFAULT_THRESHOLDS = {
  shoe: 800000,
  bike: 5000000
}

export const DEFAULT_SHOE_MAX_DISTANCE_M = DEFAULT_THRESHOLDS.shoe
export const DEFAULT_BIKE_MAX_DISTANCE_M = DEFAULT_THRESHOLDS.bike

let _store = null

/**
 * Connect the store instance to gear helpers for direct calls.
 */
export function setGearStore(store) {
  _store = store
}

/**
 * Normalizes a raw gear object into a canonical gear item.
 * Schema: { id, name, type: 'shoe'|'bike', brand, model, distanceM, maxDistanceM, isRetired, createdAt }
 */
export function normalizeGearItem(data = {}) {
  const type = data.type === 'bike' ? 'bike' : 'shoe'
  const defaultMax = DEFAULT_THRESHOLDS[type]
  const maxDistanceM =
    data.maxDistanceM != null && !isNaN(Number(data.maxDistanceM)) && Number(data.maxDistanceM) > 0
      ? Number(data.maxDistanceM)
      : defaultMax
  const distanceM =
    data.distanceM != null && !isNaN(Number(data.distanceM))
      ? Math.max(0, Number(data.distanceM))
      : 0

  return {
    id: data.id || uid(),
    name: data.name != null ? String(data.name).trim() : '',
    type,
    brand: data.brand != null ? String(data.brand).trim() : '',
    model: data.model != null ? String(data.model).trim() : '',
    distanceM,
    maxDistanceM,
    isDefault: Boolean(data.isDefault),
    isRetired: Boolean(data.isRetired || data.retired),
    createdAt: data.createdAt || new Date().toISOString()
  }
}

/**
 * Checks whether a gear item is retired (supports both isRetired and legacy retired flags).
 */
export function isGearRetired(gear) {
  return Boolean(gear && typeof gear === 'object' && (gear.isRetired || gear.retired))
}

/**
 * Filters a gear list to active (non-retired) valid gear items.
 */
export function getActiveGear(gearList) {
  return (Array.isArray(gearList) ? gearList : []).filter(
    g => g && typeof g === 'object' && !isGearRetired(g)
  )
}

/**
 * Maps a cardio sport type to its matching gear category ('bike' or 'shoe').
 */
export function gearCategoryForSport(sport) {
  return sport === 'ride' ? 'bike' : 'shoe'
}

/**
 * Resolves the default active gear id for a given cardio sport.
 * Prefers default gear matching the sport category, then first matching active gear,
 * then any default active gear, or '' if none found.
 */
export function resolveDefaultGearForSport(gearList, sport) {
  const active = getActiveGear(gearList)
  if (active.length === 0) return ''
  const cat = gearCategoryForSport(sport)
  const matching = active.filter(g => g.type === cat)
  const defMatch = matching.find(g => g.isDefault)
  if (defMatch) return defMatch.id
  if (matching.length > 0) return matching[0].id
  const anyDef = active.find(g => g.isDefault)
  return anyDef ? anyDef.id : ''
}

/**
 * Checks whether a gear item is due for retirement.
 * Returns true if not retired and distanceM >= maxDistanceM.
 */
export function isGearDueRetirement(gear) {
  if (!gear || typeof gear !== 'object') return false
  if (isGearRetired(gear)) return false
  const max =
    gear.maxDistanceM != null && Number(gear.maxDistanceM) > 0
      ? Number(gear.maxDistanceM)
      : (gear.type === 'bike' ? DEFAULT_THRESHOLDS.bike : DEFAULT_THRESHOLDS.shoe)
  const dist = Number(gear.distanceM) || 0
  return dist >= max
}

/**
 * Returns wear percentage (0 to 100+).
 */
export function getGearWearPercent(gear) {
  if (!gear || typeof gear !== 'object') return 0
  const max =
    gear.maxDistanceM != null && Number(gear.maxDistanceM) > 0
      ? Number(gear.maxDistanceM)
      : (gear.type === 'bike' ? DEFAULT_THRESHOLDS.bike : DEFAULT_THRESHOLDS.shoe)
  if (max <= 0) return 100
  const dist = Math.max(0, Number(gear.distanceM) || 0)
  return Math.min(100, Math.round((dist / max) * 100))
}

/**
 * Accumulates distanceM to gear matching gearId (by ID or case-insensitive name).
 * Signature: accumulateGearDistance(gearId, distanceM, set, get)
 */
export function accumulateGearDistance(gearId, distanceM, set, get) {
  // Support accumulateGearDistance(state, gearId, distanceM)
  if (typeof gearId === 'object' && gearId !== null && typeof distanceM === 'string') {
    const state = gearId
    const targetId = distanceM
    const dist = Number(set) || 0
    if (dist <= 0) return null
    const list = state.S?.gear || state.gear || (Array.isArray(state) ? state : null)
    if (!list) return null
    const item = list.find(g => g.id === targetId || (g.name && g.name.toLowerCase() === targetId.trim().toLowerCase()))
    if (!item) return null
    item.distanceM = (item.distanceM || 0) + dist
    return item
  }

  if (!gearId || distanceM == null || Number(distanceM) <= 0) return null
  const dist = Number(distanceM)

  // Fallback to store if set and get not provided
  if (!set && !get && _store) {
    return _store.getState().accumulateGearDistance(gearId, distanceM)
  }

  if (get && typeof get === 'function') {
    const st = get()
    // 1. Store with update method (useStore pattern)
    if (typeof st?.update === 'function') {
      let updated = null
      st.update(s => {
        if (!Array.isArray(s.gear)) s.gear = []
        const idx = s.gear.findIndex(
          g => g.id === gearId || (g.name && g.name.toLowerCase() === String(gearId).trim().toLowerCase())
        )
        if (idx !== -1) {
          s.gear[idx].distanceM = (s.gear[idx].distanceM || 0) + dist
          updated = { ...s.gear[idx] }
        }
      })
      return updated
    }

    // 2. Standalone set & get (e.g. in tests)
    if (typeof set === 'function') {
      const S = st?.S ? st.S : st
      const list = Array.isArray(S?.gear) ? [...S.gear] : []
      const idx = list.findIndex(
        g => g.id === gearId || (g.name && g.name.toLowerCase() === String(gearId).trim().toLowerCase())
      )
      if (idx !== -1) {
        list[idx] = { ...list[idx], distanceM: (list[idx].distanceM || 0) + dist }
        const updated = { ...list[idx] }
        if (st?.S) {
          set({ ...st, S: { ...st.S, gear: list } })
        } else {
          set({ ...st, gear: list })
        }
        return updated
      }
      return null
    }
  }

  // 3. Zustand set function without get
  if (typeof set === 'function') {
    let updated = null
    set(state => {
      const S = state?.S ? state.S : state
      if (!S || !Array.isArray(S.gear)) return state
      const list = [...S.gear]
      const idx = list.findIndex(
        g => g.id === gearId || (g.name && g.name.toLowerCase() === String(gearId).trim().toLowerCase())
      )
      if (idx === -1) return state
      list[idx] = { ...list[idx], distanceM: (list[idx].distanceM || 0) + dist }
      updated = { ...list[idx] }
      if (state?.S) return { ...state, S: { ...state.S, gear: list } }
      return { ...state, gear: list }
    })
    return updated
  }

  return null
}

/**
 * Adds a new gear item to store.
 * Signature: addGear(gearData, set, get)
 */
export function addGear(gearData, set, get) {
  // Support addGear(state, gearData)
  if (
    gearData &&
    typeof gearData === 'object' &&
    (gearData.S || gearData.gear || Array.isArray(gearData)) &&
    set &&
    typeof set === 'object' &&
    typeof set !== 'function'
  ) {
    const state = gearData
    const data = set
    const item = normalizeGearItem(data)
    const list = state.S?.gear || state.gear || (Array.isArray(state) ? state : null)
    if (list) list.push(item)
    return item
  }

  if (!gearData || typeof gearData !== 'object') return null
  const item = normalizeGearItem(gearData)

  if (!set && !get && _store) {
    return _store.getState().addGear(gearData)
  }

  if (get && typeof get === 'function') {
    const st = get()
    if (typeof st?.update === 'function') {
      st.update(s => {
        if (!Array.isArray(s.gear)) s.gear = []
        s.gear.push(item)
      })
      return item
    }

    if (typeof set === 'function') {
      const S = st?.S ? st.S : st
      const list = Array.isArray(S?.gear) ? [...S.gear, item] : [item]
      if (st?.S) set({ ...st, S: { ...st.S, gear: list } })
      else set({ ...st, gear: list })
      return item
    }
  }

  if (typeof set === 'function') {
    set(state => {
      const S = state?.S ? state.S : state
      const list = Array.isArray(S?.gear) ? [...S.gear, item] : [item]
      if (state?.S) return { ...state, S: { ...state.S, gear: list } }
      return { ...state, gear: list }
    })
    return item
  }

  return item
}

function applyGearPatch(item, patch) {
  const next = { ...item, ...patch }
  if (patch && patch.isRetired === false && !('retired' in patch)) {
    delete next.retired
  }
  return next
}

/**
 * Updates an existing gear item.
 * Signature: updateGear(id, patch, set, get)
 */
export function updateGear(id, patch = {}, set, get) {
  // Support updateGear(state, id, patch)
  if (typeof id === 'object' && id !== null && typeof patch === 'string' && set && typeof set === 'object') {
    const state = id
    const targetId = patch
    const patchObj = set
    const list = state.S?.gear || state.gear || (Array.isArray(state) ? state : null)
    if (!list) return null
    const idx = list.findIndex(g => g.id === targetId)
    if (idx === -1) return null
    list[idx] = applyGearPatch(list[idx], patchObj)
    return list[idx]
  }

  if (!id) return null
  let updated = null

  if (!set && !get && _store) {
    return _store.getState().updateGear(id, patch)
  }

  if (get && typeof get === 'function') {
    const st = get()
    if (typeof st?.update === 'function') {
      st.update(s => {
        if (!Array.isArray(s.gear)) s.gear = []
        const idx = s.gear.findIndex(g => g.id === id)
        if (idx !== -1) {
          s.gear[idx] = applyGearPatch(s.gear[idx], patch)
          updated = { ...s.gear[idx] }
        }
      })
      return updated
    }

    if (typeof set === 'function') {
      const S = st?.S ? st.S : st
      const list = Array.isArray(S?.gear) ? [...S.gear] : []
      const idx = list.findIndex(g => g.id === id)
      if (idx !== -1) {
        list[idx] = applyGearPatch(list[idx], patch)
        updated = { ...list[idx] }
        if (st?.S) set({ ...st, S: { ...st.S, gear: list } })
        else set({ ...st, gear: list })
      }
      return updated
    }
  }

  if (typeof set === 'function') {
    set(state => {
      const S = state?.S ? state.S : state
      if (!S || !Array.isArray(S.gear)) return state
      const list = [...S.gear]
      const idx = list.findIndex(g => g.id === id)
      if (idx !== -1) {
        list[idx] = applyGearPatch(list[idx], patch)
        updated = { ...list[idx] }
        if (state?.S) return { ...state, S: { ...state.S, gear: list } }
        return { ...state, gear: list }
      }
      return state
    })
    return updated
  }

  return updated
}

/**
 * Retires a gear item (sets isRetired: true).
 * Signature: retireGear(id, set, get)
 */
export function retireGear(id, set, get) {
  return updateGear(id, { isRetired: true, isDefault: false }, set, get)
}

/**
 * Sets or toggles default gear scoped per sport type ('shoe' | 'bike').
 * Setting a default shoe clears previous default shoe without touching bikes.
 * If the target gear is already isDefault, toggles it off unless forceOn is true.
 * Signature: setDefaultGear(id, set, get)
 */
export function setDefaultGear(id, set, get) {
  // Support setDefaultGear(state, id)
  if (typeof id === 'object' && id !== null && typeof set === 'string') {
    const state = id
    const targetId = set
    const list = state.S?.gear || state.gear || (Array.isArray(state) ? state : null)
    if (!list) return null
    const target = list.find(g => g.id === targetId)
    if (!target) return null
    const nextVal = !target.isDefault
    const targetType = target.type === 'bike' ? 'bike' : 'shoe'
    let updated = null
    list.forEach((g, idx) => {
      const gType = g.type === 'bike' ? 'bike' : 'shoe'
      if (g.id === targetId) {
        list[idx] = { ...g, isDefault: nextVal }
        updated = list[idx]
      } else if (nextVal && gType === targetType && g.isDefault) {
        list[idx] = { ...g, isDefault: false }
      }
    })
    return updated
  }

  if (!id) return null
  let updated = null

  if (!set && !get && _store) {
    if (typeof _store.getState().setDefaultGear === 'function') {
      return _store.getState().setDefaultGear(id)
    }
    return setDefaultGear(id, _store.setState, _store.getState)
  }

  if (get && typeof get === 'function') {
    const st = get()
    if (typeof st?.update === 'function') {
      st.update(s => {
        if (!Array.isArray(s.gear)) s.gear = []
        const target = s.gear.find(g => g.id === id)
        if (!target) return
        const nextVal = !target.isDefault
        const targetType = target.type === 'bike' ? 'bike' : 'shoe'
        s.gear = s.gear.map(g => {
          const gType = g.type === 'bike' ? 'bike' : 'shoe'
          if (g.id === id) {
            updated = { ...g, isDefault: nextVal }
            return updated
          }
          if (nextVal && gType === targetType && g.isDefault) {
            return { ...g, isDefault: false }
          }
          return g
        })
      })
      return updated
    }

    if (typeof set === 'function') {
      const S = st?.S ? st.S : st
      const rawList = Array.isArray(S?.gear) ? S.gear : []
      const target = rawList.find(g => g.id === id)
      if (!target) return null
      const nextVal = !target.isDefault
      const targetType = target.type === 'bike' ? 'bike' : 'shoe'
      const list = rawList.map(g => {
        const gType = g.type === 'bike' ? 'bike' : 'shoe'
        if (g.id === id) {
          updated = { ...g, isDefault: nextVal }
          return updated
        }
        if (nextVal && gType === targetType && g.isDefault) {
          return { ...g, isDefault: false }
        }
        return g
      })
      if (st?.S) set({ ...st, S: { ...st.S, gear: list } })
      else set({ ...st, gear: list })
      return updated
    }
  }

  if (typeof set === 'function') {
    set(state => {
      const S = state?.S ? state.S : state
      if (!S || !Array.isArray(S.gear)) return state
      const target = S.gear.find(g => g.id === id)
      if (!target) return state
      const nextVal = !target.isDefault
      const targetType = target.type === 'bike' ? 'bike' : 'shoe'
      const list = S.gear.map(g => {
        const gType = g.type === 'bike' ? 'bike' : 'shoe'
        if (g.id === id) {
          updated = { ...g, isDefault: nextVal }
          return updated
        }
        if (nextVal && gType === targetType && g.isDefault) {
          return { ...g, isDefault: false }
        }
        return g
      })
      if (state?.S) return { ...state, S: { ...state.S, gear: list } }
      return { ...state, gear: list }
    })
    return updated
  }

  return updated
}
