import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Library, { dedupeRoutes } from './Library.jsx'
import { exerciseModality, exercisePillarClass, MODALITIES } from '../lib/exercises.js'

describe('exerciseModality (Issue #95)', () => {
  it('maps catalogue categories to modalities', () => {
    expect(exerciseModality({ cat: 'yoga' })).toBe('yoga')
    expect(exerciseModality({ cat: 'stretching' })).toBe('mobility')
    expect(exerciseModality({ cat: 'cardio' })).toBe('cardio')
    expect(exerciseModality({ cat: 'plyometrics' })).toBe('cardio')
    expect(exerciseModality({ cat: 'strength' })).toBe('strength')
  })
  it('falls back to strength so no exercise vanishes; custom cardio body part is cardio', () => {
    expect(exerciseModality({})).toBe('strength')
    expect(exerciseModality(null)).toBe('strength')
    expect(exerciseModality({ bp: 'cardio' })).toBe('cardio')
  })
  it('exposes pillar classes and the 4 modalities', () => {
    expect(MODALITIES.map(m => m.id)).toEqual(['strength', 'yoga', 'mobility', 'cardio'])
    expect(exercisePillarClass({ cat: 'yoga' })).toBe('pillar-flow')
    expect(exercisePillarClass({ cat: 'cardio' })).toBe('pillar-cardio')
    expect(exercisePillarClass({ cat: 'strength' })).toBe('pillar-strength')
  })
})

describe('dedupeRoutes (Issue #95)', () => {
  it('merges S.routes and S.savedRoutes by id and tolerates missing arrays', () => {
    const out = dedupeRoutes({ routes: [{ id: 'a' }, { id: 'b' }], savedRoutes: [{ id: 'b' }, { id: 'c' }] })
    expect(out.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(dedupeRoutes({})).toEqual([])
  })
})

describe('Library view (Issue #95)', () => {
  it('renders the Exercises | Routes | Gear segmented control and modality pills', () => {
    const html = renderToStaticMarkup(React.createElement(Library))
    expect(html).toContain('Exercises')
    expect(html).toContain('Routes')
    expect(html).toContain('Gear')
    expect(html).toContain('Yoga')
    expect(html).toContain('Mobility')
    expect(html).toContain('HIIT / Cardio')
  })
  it('renders the Routes section with import and empty state', () => {
    const html = renderToStaticMarkup(React.createElement(Library, { initialSection: 'routes' }))
    expect(html).toContain('Import GPX')
    expect(html).toContain('accept=".gpx')
  })
})
