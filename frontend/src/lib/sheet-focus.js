// Pure focus helpers for the Sheet primitive (issue #103). DOM-stub friendly:
// they only need `querySelector` / `focus`, so tests run without jsdom.

export const FOCUSABLE = 'button:not([disabled]):not([hidden]), a[href]:not([hidden]), input:not([disabled]):not([type="hidden"]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])'

export const isEscape = e => !!e && e.key === 'Escape'

export const firstFocusable = el => (el && el.querySelector ? el.querySelector(FOCUSABLE) : null)

export const restoreFocus = el => { if (el && el.focus) el.focus() }
