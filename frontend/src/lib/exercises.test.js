import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXDB, EXIDX, imgSrc, gifSrc, isCardio, BODYPARTS } from './exercises.js'

describe('Exercise catalogue and schema (Issue #43)', () => {
  const VALID_CATEGORIES = ['strength', 'yoga', 'stretching', 'plyometrics', 'cardio']

  it('contains over 1,500 exercises without duplicate IDs', () => {
    expect(EXDB.length).toBeGreaterThan(1500)
    const ids = new Set()
    for (const ex of EXDB) {
      expect(ex.id).toBeTruthy()
      expect(typeof ex.id).toBe('string')
      expect(ids.has(ex.id)).toBe(false)
      ids.add(ex.id)
    }
    expect(ids.size).toBe(EXDB.length)
    expect(Object.keys(EXIDX).length).toBeGreaterThanOrEqual(EXDB.length)
  })

  it('validates required schema fields for every exercise in EXDB', () => {
    for (const ex of EXDB) {
      expect(ex.id).toBeTypeOf('string')
      expect(ex.n).toBeTypeOf('string')
      expect(ex.n.length).toBeGreaterThan(0)
      expect(ex.bp).toBeTypeOf('string')
      expect(ex.bp.length).toBeGreaterThan(0)
      expect(ex.eq).toBeTypeOf('string')
      expect(ex.eq.length).toBeGreaterThan(0)
      expect(ex.tg).toBeTypeOf('string')
      expect(ex.tg.length).toBeGreaterThan(0)
      expect(Array.isArray(ex.st)).toBe(true)
      expect(ex.cat).toBeTypeOf('string')
      expect(VALID_CATEGORIES).toContain(ex.cat)
    }
  })

  it('tags every exercise with a valid category and represents all 5 categories', () => {
    const counts = { strength: 0, yoga: 0, stretching: 0, plyometrics: 0, cardio: 0 }
    for (const ex of EXDB) {
      counts[ex.cat] = (counts[ex.cat] || 0) + 1
    }

    expect(counts.strength).toBeGreaterThan(1000)
    expect(counts.yoga).toBe(48)
    expect(counts.stretching).toBeGreaterThan(100)
    expect(counts.plyometrics).toBeGreaterThan(50)
    expect(counts.cardio).toBeGreaterThan(20)
  })

  it('includes ~48 yoga poses with bundled CC0 vector SVGs and valid data URIs', () => {
    const yogaPoses = EXDB.filter(e => e.cat === 'yoga')
    expect(yogaPoses).toHaveLength(48)

    for (const pose of yogaPoses) {
      expect(pose.id).toMatch(/^yoga-\d+$/)
      expect(pose.eq).toBe('body weight')
      expect(pose.svg).toBeTypeOf('string')
      expect(pose.svg.startsWith('<svg')).toBe(true)
      expect(pose.svg.endsWith('</svg>')).toBe(true)

      const thumbUri = imgSrc(pose)
      expect(thumbUri).toContain('data:image/svg+xml;utf8,')
      expect(thumbUri).toContain('%3Csvg')

      const workoutUri = gifSrc(pose)
      expect(workoutUri).toBe(thumbUri)
    }
  })

  it('correctly associates cardio exercises with isCardio helper', () => {
    const cardioExercises = EXDB.filter(e => e.cat === 'cardio' || e.bp === 'cardio')
    expect(cardioExercises.length).toBeGreaterThan(20)
    for (const ex of cardioExercises) {
      if (ex.bp === 'cardio') {
        expect(isCardio(ex.id)).toBe(true)
        expect(isCardio(ex)).toBe(true)
      }
    }
  })

  it('keeps shared/coach/library.json synchronized with EXDB', () => {
    // Resolve shared/coach/library.json relative to repository root
    const libraryPath = join(process.cwd(), '..', 'shared', 'coach', 'library.json')
    const raw = readFileSync(libraryPath, 'utf8')
    const coachLib = JSON.parse(raw)

    expect(coachLib.generated_from).toBe('frontend/src/lib/exercises-data.js')
    expect(coachLib.count).toBe(EXDB.length)
    expect(coachLib.exercises).toHaveLength(EXDB.length)

    for (let i = 0; i < EXDB.length; i++) {
      const dbEx = EXDB[i]
      const coachEx = coachLib.exercises[i]
      expect(coachEx.id).toBe(dbEx.id)
      expect(coachEx.n).toBe(dbEx.n)
      expect(coachEx.bp).toBe(dbEx.bp)
      expect(coachEx.tg).toBe(dbEx.tg)
      expect(coachEx.eq).toBe(dbEx.eq)
    }
  })
})
