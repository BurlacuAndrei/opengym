import { describe, it, expect } from 'vitest'
import { fmtDate } from './format.js'

const fmtLocal = (d, long = false) =>
  d.toLocaleDateString('en-GB', long ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' })

describe('fmtDate', () => {
  it('parses YYYY-MM-DD as local noon', () => {
    const expectedShort = fmtLocal(new Date(2026, 10, 12, 12, 0, 0), false)
    const expectedLong = fmtLocal(new Date(2026, 10, 12, 12, 0, 0), true)

    expect(fmtDate('2026-11-12')).toBe(expectedShort)
    expect(fmtDate('2026-11-12', true)).toBe(expectedLong)
    expect(fmtDate(' 2026-11-12 ', true)).toBe(expectedLong)
  })

  it('returns empty string for invalid calendar dates', () => {
    expect(fmtDate('2026-02-30')).toBe('')
    expect(fmtDate('2026-04-31')).toBe('')
    expect(fmtDate('2026-13-01')).toBe('')
    expect(fmtDate('2026-00-10')).toBe('')
  })

  it('parses full ISO timestamps and space-separated datetimes without Invalid Date', () => {
    const inputs = [
      '2026-11-12T14:30:00Z',
      '2026-11-12T14:30:00+02:00',
      '2026-11-12T14:30:00-05:00',
      '2026-11-12T14:30:00.123Z',
      '2026-11-12 14:30:00',
    ]
    for (const s of inputs) {
      const res = fmtDate(s, true)
      expect(res).toBe(fmtLocal(new Date(s), true))
      expect(res).not.toBe('')
      expect(res).not.toContain('Invalid Date')
    }
  })

  it('converts ISO timestamps into local timezone', () => {
    const lateLocal = new Date(2026, 10, 12, 23, 30, 0)
    const iso = lateLocal.toISOString()
    expect(fmtDate(iso, true)).toBe(fmtLocal(lateLocal, true))
  })

  it('accepts valid Date instances and positive finite epoch ms', () => {
    const d = new Date(2026, 10, 12, 12, 0, 0)
    const expected = fmtLocal(d, true)

    expect(fmtDate(d, true)).toBe(expected)
    expect(fmtDate(d.getTime(), true)).toBe(expected)
  })

  it('returns empty string for nullish, invalid, numeric-only, or incomplete inputs', () => {
    const invalidInputs = [
      null,
      undefined,
      '',
      '   ',
      0,
      -1,
      NaN,
      Infinity,
      -Infinity,
      true,
      false,
      {},
      [],
      'invalid',
      '2026',
      '1731400000',
      '2026-11',
      new Date(NaN),
    ]
    for (const v of invalidInputs) {
      expect(fmtDate(v)).toBe('')
      expect(fmtDate(v, true)).toBe('')
    }
  })
})
