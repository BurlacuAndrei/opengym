import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_SHOE_MAX_DISTANCE_M,
  DEFAULT_BIKE_MAX_DISTANCE_M,
  normalizeGearItem,
  isGearDueRetirement,
  getGearWearPercent,
  accumulateGearDistance,
  addGear,
  updateGear,
  retireGear
} from './gear.js'
import {
  useStore,
  DEF,
  hasData,
  logCardioActivity,
  addGear as storeAddGear,
  updateGear as storeUpdateGear,
  retireGear as storeRetireGear,
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
  })

  describe('Retirement Checks & Wear Calculation', () => {
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
  })
})
