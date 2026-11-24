import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_SHOE_MAX_DISTANCE_M,
  DEFAULT_BIKE_MAX_DISTANCE_M,
  normalizeGearItem,
  isGearRetired,
  getActiveGear,
  gearCategoryForSport,
  resolveDefaultGearForSport,
  isGearDueRetirement,
  getGearWearPercent,
  accumulateGearDistance,
  addGear,
  updateGear,
  retireGear,
  setDefaultGear
} from './gear.js'
import {
  useStore,
  DEF,
  hasData,
  logCardioActivity,
  addGear as storeAddGear,
  updateGear as storeUpdateGear,
  retireGear as storeRetireGear,
  setDefaultGear as storeSetDefaultGear,
  accumulateGearDistance as storeAccumulateGearDistance
} from '../store/useStore.js'
import GearManager, { openGearManager } from '../components/GearManager.jsx'
import { useUI } from '../store/useUI.js'

if (typeof globalThis.localStorage === 'undefined') {
  let store = {}
  globalThis.localStorage = {
    getItem: vi.fn(k => store[k] ?? null),
    setItem: vi.fn((k, v) => { store[k] = String(v) }),
    removeItem: vi.fn(k => { delete store[k] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store }
  }
}

describe('Gear Mileage Tracker (Issue #54)', () => {
  beforeEach(() => {
    localStorage.clear()
    useStore.setState({
      S: JSON.parse(JSON.stringify(DEF)),
      user: null
    })
  })

  describe('Default Thresholds & Normalization', () => {
    it('defines standard retirement thresholds for shoes and bikes', () => {
      expect(DEFAULT_THRESHOLDS.shoe).toBe(800000)
      expect(DEFAULT_THRESHOLDS.bike).toBe(5000000)
      expect(DEFAULT_SHOE_MAX_DISTANCE_M).toBe(800000)
      expect(DEFAULT_BIKE_MAX_DISTANCE_M).toBe(5000000)
    })

    it('normalizeGearItem sets default thresholds and canonical schema', () => {
      const shoe = normalizeGearItem({ name: 'Pegasus 40' })
      expect(shoe.id).toBeDefined()
      expect(shoe.name).toBe('Pegasus 40')
      expect(shoe.type).toBe('shoe')
      expect(shoe.maxDistanceM).toBe(800000)
      expect(shoe.distanceM).toBe(0)
      expect(shoe.isRetired).toBe(false)
      expect(shoe.createdAt).toBeDefined()

      const bike = normalizeGearItem({ name: 'Trek Domane', type: 'bike', brand: 'Trek', model: 'Domane SL 6' })
      expect(bike.type).toBe('bike')
      expect(bike.maxDistanceM).toBe(5000000)
      expect(bike.brand).toBe('Trek')
      expect(bike.model).toBe('Domane SL 6')
    })

    it('normalizeGearItem preserves custom maxDistanceM and initial distanceM', () => {
      const item = normalizeGearItem({
        name: 'Racing Flats',
        type: 'shoe',
        maxDistanceM: 400000,
        distanceM: 50000
      })
      expect(item.maxDistanceM).toBe(400000)
      expect(item.distanceM).toBe(50000)
    })

    it('normalizeGearItem honors legacy retired flag', () => {
      expect(normalizeGearItem({ name: 'Legacy Shoe', retired: true }).isRetired).toBe(true)
    })
  })

  describe('Retirement Checks & Wear Calculation', () => {
    it('isGearRetired and getActiveGear handle isRetired, retired, mixed flags, and null/undefined', () => {
      expect(isGearRetired({ isRetired: true })).toBe(true)
      expect(isGearRetired({ retired: true })).toBe(true)
      expect(isGearRetired({ isRetired: false, retired: true })).toBe(true)
      expect(isGearRetired({ isRetired: true, retired: false })).toBe(true)
      expect(isGearRetired({ isRetired: false, retired: false })).toBe(false)
      expect(isGearRetired(null)).toBe(false)
      expect(isGearRetired(undefined)).toBe(false)
      expect(isGearRetired('shoe')).toBe(false)

      const active = { id: 'a1', name: 'Active', isRetired: false }
      const list = [
        active,
        { id: 'r1', isRetired: true },
        { id: 'r2', retired: true },
        { id: 'r3', isRetired: false, retired: true },
        null,
        undefined
      ]
      expect(getActiveGear(list)).toEqual([active])
      expect(getActiveGear(null)).toEqual([])
      expect(getActiveGear(undefined)).toEqual([])
    })

    it('gearCategoryForSport and resolveDefaultGearForSport resolve active defaults by sport', () => {
      expect(gearCategoryForSport('ride')).toBe('bike')
      expect(gearCategoryForSport('run')).toBe('shoe')
      expect(gearCategoryForSport('walk')).toBe('shoe')
      expect(gearCategoryForSport('hike')).toBe('shoe')

      const gear = [
        null,
        { id: 'r1', name: 'Retired Default', type: 'shoe', isDefault: true, isRetired: true },
        { id: 'r2', name: 'Legacy Retired', type: 'shoe', isDefault: true, retired: true },
        { id: 's1', name: 'Trainer', type: 'shoe', isDefault: false, isRetired: false },
        { id: 's2', name: 'Racer', type: 'shoe', isDefault: true, isRetired: false },
        { id: 'b1', name: 'Road Bike', type: 'bike', isDefault: false, isRetired: false }
      ]
      expect(resolveDefaultGearForSport(gear, 'run')).toBe('s2')
      expect(resolveDefaultGearForSport(gear, 'ride')).toBe('b1')
      // Falls back to any active default if no gear matches category
      expect(resolveDefaultGearForSport([{ id: 's2', type: 'shoe', isDefault: true }], 'ride')).toBe('s2')
      expect(resolveDefaultGearForSport([{ id: 's1', type: 'shoe', isDefault: false }], 'ride')).toBe('')
      expect(resolveDefaultGearForSport([], 'run')).toBe('')
      expect(resolveDefaultGearForSport(null, 'run')).toBe('')
    })
    it('isGearDueRetirement returns true when distance reaches or exceeds maxDistanceM', () => {
      const shoe = { id: 's1', type: 'shoe', distanceM: 800000, maxDistanceM: 800000, isRetired: false }
      expect(isGearDueRetirement(shoe)).toBe(true)

      const wornShoe = { ...shoe, distanceM: 850000 }
      expect(isGearDueRetirement(wornShoe)).toBe(true)
    })

    it('isGearDueRetirement returns false when distance is below threshold', () => {
      const shoe = { id: 's1', type: 'shoe', distanceM: 799999, maxDistanceM: 800000, isRetired: false }
      expect(isGearDueRetirement(shoe)).toBe(false)
    })

    it('isGearDueRetirement returns false when gear is already retired', () => {
      const retiredShoe = { id: 's1', type: 'shoe', distanceM: 900000, maxDistanceM: 800000, isRetired: true }
      expect(isGearDueRetirement(retiredShoe)).toBe(false)
      const legacyRetiredShoe = { id: 's2', type: 'shoe', distanceM: 900000, maxDistanceM: 800000, retired: true }
      expect(isGearDueRetirement(legacyRetiredShoe)).toBe(false)
    })

    it('getGearWearPercent calculates correct wear percentage up to 100', () => {
      const halfWorn = { id: 's1', type: 'shoe', distanceM: 400000, maxDistanceM: 800000 }
      expect(getGearWearPercent(halfWorn)).toBe(50)

      const zeroWorn = { id: 's1', type: 'shoe', distanceM: 0, maxDistanceM: 800000 }
      expect(getGearWearPercent(zeroWorn)).toBe(0)

      const overWorn = { id: 's1', type: 'shoe', distanceM: 1000000, maxDistanceM: 800000 }
      expect(getGearWearPercent(overWorn)).toBe(100)
    })
  })

  describe('Helper Functions with (set, get)', () => {
    it('accumulateGearDistance accumulates distance with set and get', () => {
      let state = {
        S: {
          gear: [
            { id: 'shoe-1', name: 'Pegasus 40', distanceM: 10000, maxDistanceM: 800000, isRetired: false },
            { id: 'bike-1', name: 'Gravel Bike', distanceM: 20000, maxDistanceM: 5000000, isRetired: false }
          ]
        }
      }
      const set = vi.fn(next => {
        state = typeof next === 'function' ? next(state) : next
      })
      const get = () => state

      const updated = accumulateGearDistance('shoe-1', 5000, set, get)
      expect(updated).not.toBeNull()
      expect(updated.distanceM).toBe(15000)
      expect(set).toHaveBeenCalled()
      expect(state.S.gear[0].distanceM).toBe(15000)
    })

    it('accumulateGearDistance resolves gear by name if ID does not match', () => {
      let state = {
        S: {
          gear: [
            { id: 'shoe-1', name: 'Speedgoat 5', distanceM: 0, maxDistanceM: 800000, isRetired: false }
          ]
        }
      }
      const set = vi.fn(next => {
        state = typeof next === 'function' ? next(state) : next
      })
      const get = () => state

      const updated = accumulateGearDistance('Speedgoat 5', 12000, set, get)
      expect(updated).not.toBeNull()
      expect(updated.distanceM).toBe(12000)
    })

    it('accumulateGearDistance returns null for invalid distances or non-existent gear', () => {
      let state = { S: { gear: [] } }
      const set = vi.fn()
      const get = () => state

      expect(accumulateGearDistance('shoe-1', 0, set, get)).toBeNull()
      expect(accumulateGearDistance('shoe-1', -100, set, get)).toBeNull()
      expect(accumulateGearDistance('unknown-id', 5000, set, get)).toBeNull()
      expect(set).not.toHaveBeenCalled()
    })

    it('addGear, updateGear, and retireGear manipulate gear items', () => {
      let state = { S: { gear: [] } }
      const set = vi.fn(next => {
        state = typeof next === 'function' ? next(state) : next
      })
      const get = () => state

      const created = addGear({ name: 'Alphafly', type: 'shoe' }, set, get)
      expect(created.id).toBeDefined()
      expect(state.S.gear).toHaveLength(1)

      const updated = updateGear(created.id, { brand: 'Nike' }, set, get)
      expect(updated.brand).toBe('Nike')
      expect(state.S.gear[0].brand).toBe('Nike')

      const retired = retireGear(created.id, set, get)
      expect(retired.isRetired).toBe(true)
      expect(state.S.gear[0].isRetired).toBe(true)
    })

    it('updateGear clears stale retired key when reactivating with isRetired: false', () => {
      let state = { S: { gear: [{ id: 'g1', name: 'Old Shoe', isRetired: true, retired: true }] } }
      const set = vi.fn(next => {
        state = typeof next === 'function' ? next(state) : next
      })
      const get = () => state

      const reactivated = updateGear('g1', { isRetired: false }, set, get)
      expect(reactivated.isRetired).toBe(false)
      expect('retired' in reactivated).toBe(false)
      expect('retired' in state.S.gear[0]).toBe(false)

      // Also clears across state-signature and store update() branches
      const directState = { S: { gear: [{ id: 'g2', isRetired: true, retired: true }] } }
      const directRes = updateGear(directState, 'g2', { isRetired: false })
      expect('retired' in directRes).toBe(false)

      storeAddGear({ id: 'g3', name: 'Store Shoe', isRetired: true, retired: true })
      const storeRes = storeUpdateGear('g3', { isRetired: false })
      expect(storeRes.isRetired).toBe(false)
      expect('retired' in storeRes).toBe(false)
    })
  })

  describe('useStore & Cardio Activity Integration', () => {
    it('DEF includes empty gear array and hasData recognizes gear', () => {
      expect(DEF.gear).toEqual([])
      expect(hasData({ gear: [{ id: 'g1' }] })).toBe(true)
      expect(hasData({ gear: [] })).toBe(false)
    })

    it('storeAddGear and storeRetireGear update store state', () => {
      const item = storeAddGear({ name: 'Vaporfly 3', type: 'shoe', brand: 'Nike' })
      expect(useStore.getState().S.gear).toHaveLength(1)
      expect(useStore.getState().S.gear[0].name).toBe('Vaporfly 3')

      storeRetireGear(item.id)
      expect(useStore.getState().S.gear[0].isRetired).toBe(true)
    })

    it('logCardioActivity with gearId automatically accumulates distance to gear', () => {
      const shoe = storeAddGear({ id: 'shoe-run-1', name: 'Ghost 15', type: 'shoe', distanceM: 10000 })
      expect(shoe.distanceM).toBe(10000)

      // Log a 5km run using this shoe
      logCardioActivity({
        type: 'run',
        distanceM: 5000,
        durationMs: 1500000,
        gearId: 'shoe-run-1'
      })

      const storedGear = useStore.getState().S.gear.find(g => g.id === 'shoe-run-1')
      expect(storedGear.distanceM).toBe(15000)
    })

    it('logCardioActivity matching gear name also accumulates distance', () => {
      storeAddGear({ id: 'bike-trek', name: 'Domane AL', type: 'bike', distanceM: 50000 })

      logCardioActivity({
        type: 'ride',
        distanceM: 30000,
        durationMs: 3600000,
        gearId: 'Domane AL'
      })

      const storedGear = useStore.getState().S.gear.find(g => g.id === 'bike-trek')
      expect(storedGear.distanceM).toBe(80000)
    })

    it('logCardioActivity without gearId leaves gear mileage unchanged', () => {
      storeAddGear({ id: 'shoe-solo', name: 'Solo Shoe', type: 'shoe', distanceM: 2000 })

      logCardioActivity({
        type: 'run',
        distanceM: 4000,
        durationMs: 1200000
      })

      const storedGear = useStore.getState().S.gear.find(g => g.id === 'shoe-solo')
      expect(storedGear.distanceM).toBe(2000)
    })
  })

  describe('GearManager Component', () => {
    it('renders empty state when no gear exists', () => {
      const html = renderToStaticMarkup(
        React.createElement(GearManager, { gear: [] })
      )
      expect(html).toContain('Gear Tracker')
      expect(html).toContain('No active gear yet')
    })

    it('renders active gear list with wear progress bar and retirement alert', () => {
      const testGear = [
        {
          id: 'g-normal',
          name: 'Pegasus 40',
          type: 'shoe',
          brand: 'Nike',
          distanceM: 400000,
          maxDistanceM: 800000,
          isRetired: false
        },
        {
          id: 'g-worn',
          name: 'Old Runner',
          type: 'shoe',
          brand: 'Brooks',
          distanceM: 820000,
          maxDistanceM: 800000,
          isRetired: false
        }
      ]

      const html = renderToStaticMarkup(
        React.createElement(GearManager, { gear: testGear, unit: 'kg' })
      )

      expect(html).toContain('Pegasus 40')
      expect(html).toContain('Old Runner')
      expect(html).toContain('50% wear')
      expect(html).toContain('100% wear')
      // Retirement alert rendered for worn item
      expect(html).toContain('Retirement recommended (threshold reached)')
      expect(html).toContain('Retire')
    })

    it('openGearManager helper opens sheet via useUI', () => {
      const openSheetSpy = vi.fn()
      useUI.setState({ openSheet: openSheetSpy })

      openGearManager()
      expect(openSheetSpy).toHaveBeenCalledTimes(1)
      expect(typeof openSheetSpy.mock.calls[0][0]).toBe('function')
    })

    it('setDefaultGear scopes default toggle per sport type and GearManager supports inline prop', () => {
      const s1 = storeAddGear({ id: 's1', name: 'Pegasus 40', type: 'shoe' })
      const s2 = storeAddGear({ id: 's2', name: 'Vaporfly 3', type: 'shoe' })
      const b1 = storeAddGear({ id: 'b1', name: 'Canyon Endurace', type: 'bike' })

      expect(s1.isDefault).toBe(false)

      // Set shoe s1 as default
      storeSetDefaultGear('s1')
      expect(useStore.getState().S.gear.find(g => g.id === 's1').isDefault).toBe(true)

      // Set bike b1 as default -> s1 remains default shoe
      storeSetDefaultGear('b1')
      expect(useStore.getState().S.gear.find(g => g.id === 's1').isDefault).toBe(true)
      expect(useStore.getState().S.gear.find(g => g.id === 'b1').isDefault).toBe(true)

      // Set shoe s2 as default -> clears s1 default, keeps b1 default
      storeSetDefaultGear('s2')
      expect(useStore.getState().S.gear.find(g => g.id === 's1').isDefault).toBe(false)
      expect(useStore.getState().S.gear.find(g => g.id === 's2').isDefault).toBe(true)
      expect(useStore.getState().S.gear.find(g => g.id === 'b1').isDefault).toBe(true)

      // Retiring s2 clears its isDefault flag
      storeRetireGear('s2')
      expect(useStore.getState().S.gear.find(g => g.id === 's2').isDefault).toBe(false)

      const inlineHtml = renderToStaticMarkup(
        React.createElement(GearManager, {
          gear: useStore.getState().S.gear,
          unit: 'kg',
          inline: true
        })
      )
      expect(inlineHtml).not.toContain('Gear Tracker')
      expect(inlineHtml).toContain('Default')
      expect(inlineHtml).toContain('Set default')
    })

    it('renders sm button classes and counts both isRetired and retired items in Retired tab', () => {
      const html = renderToStaticMarkup(
        React.createElement(GearManager, {
          gear: [
            { id: 'a1', name: 'Active Shoe', type: 'shoe', distanceM: 1000, maxDistanceM: 800000, isRetired: false },
            { id: 'r1', name: 'Retired Canonical', type: 'shoe', distanceM: 1000, maxDistanceM: 800000, isRetired: true },
            { id: 'r2', name: 'Retired Legacy', type: 'shoe', distanceM: 1000, maxDistanceM: 800000, retired: true },
            { id: 'r3', name: 'Retired Mixed', type: 'shoe', distanceM: 1000, maxDistanceM: 800000, isRetired: false, retired: true }
          ],
          unit: 'kg'
        })
      )
      expect(html).toContain('Active (1)')
      expect(html).toContain('Retired (3)')
      expect(html).toContain('btn primary sm')
      expect(html).toContain('btn plain sm')
      expect(html).not.toContain('small')
    })
  })
})
