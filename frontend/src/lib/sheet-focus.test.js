import { describe, it, expect, vi } from 'vitest'
import { isEscape, firstFocusable, restoreFocus, FOCUSABLE } from './sheet-focus.js'

const el = (tag, props = {}, children = []) => ({
  tag,
  ...props,
  children,
  querySelector: vi.fn(sel => {
    // minimal selector engine: interprets the real FOCUSABLE parts, first match in DOM order
    if (sel !== FOCUSABLE) return null
    const matches = n => FOCUSABLE.split(', ').some(part => {
      const tag = /^[a-z]+/.exec(part)?.[0]
      if (tag !== undefined && n.tag !== tag) return false
      if (part.includes('[href]') && n.href === undefined) return false
      if (part.includes('[tabindex]') && n.tabIndex === undefined) return false
      if (part.includes('[disabled]') && n.disabled) return false
      if (part.includes('[type="hidden"]') && n.type === 'hidden') return false
      if (part.includes('[hidden]') && n.hidden) return false
      if (part.includes('[tabindex="-1"]') && n.tabIndex === -1) return false
      return true
    })
    const walk = n => {
      if (matches(n)) return n
      for (const c of n.children || []) { const f = walk(c); if (f) return f }
      return null
    }
    return walk({ tag: 'root', children }) || null
  }),
})

describe('sheet-focus helpers (issue #103)', () => {
  it('isEscape: only Escape counts', () => {
    expect(isEscape({ key: 'Escape' })).toBe(true)
    expect(isEscape({ key: 'Esc' })).toBe(false)
    expect(isEscape({ key: 'Enter' })).toBe(false)
    expect(isEscape(null)).toBe(false)
  })

  it('firstFocusable picks enabled button over disabled input', () => {
    const root = el('div', {}, [
      el('input', { disabled: true }),
      el('button', { type: 'button' }),
      el('input', {}),
    ])
    const f = firstFocusable(root)
    expect(f.tag).toBe('button')
  })

  it('firstFocusable skips hidden inputs', () => {
    const root = el('div', {}, [
      el('input', { type: 'hidden' }),
      el('input', { hidden: true }),
      el('button', { type: 'button' }),
    ])
    expect(firstFocusable(root).tag).toBe('button')
  })

  it('firstFocusable skips tabindex="-1" but keeps [tabindex], null-safe', () => {
    const root = el('div', {}, [
      el('div', { tabIndex: -1 }),
      el('div', { tabIndex: 0 }),
    ])
    expect(firstFocusable(root).tabIndex).toBe(0)
    expect(firstFocusable(null)).toBe(null)
    expect(firstFocusable({})).toBe(null)
  })

  it('restoreFocus calls focus() on the saved trigger', () => {
    const trigger = { focus: vi.fn() }
    restoreFocus(trigger)
    expect(trigger.focus).toHaveBeenCalledTimes(1)
  })

  it('restoreFocus tolerates missing element or focus method', () => {
    expect(() => restoreFocus(null)).not.toThrow()
    expect(() => restoreFocus({})).not.toThrow()
  })
})
