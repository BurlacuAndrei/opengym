import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Regression guard for issue #109: fixed bottom tab bar (Start circle top ~105px+sab)
// must stay clear of content. Keep #app padding-bottom and html scroll-padding-bottom in sync.
const css = readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8')

const rule = (sel) => {
  const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

describe('index.css bottom-bar clearance', () => {
  it('#app bottom padding clears the fixed tab bar (>=120px + sab)', () => {
    const m = rule('#app').match(/calc\((\d+)px \+ var\(--sab\)\)/)
    expect(m).not.toBeNull()
    expect(Number(m[1])).toBeGreaterThanOrEqual(120)
  })

  it('html scroll-padding-bottom uses the same px value as #app padding', () => {
    const appPx = rule('#app').match(/calc\((\d+)px \+ var\(--sab\)\)/)?.[1]
    const htmlPx = rule('html').match(/scroll-padding-bottom:\s*calc\((\d+)px \+ var\(--sab\)\)/)?.[1]
    expect(appPx).toBeDefined()
    expect(htmlPx).toBe(appPx)
  })
})

// Regression guard for issue #113 responsive shell: tablet 2-col at 768px,
// desktop sidebar at 1024px, base mobile layout untouched (#101 guard).
describe('index.css responsive shell', () => {
  const block = w => {
    const i = css.indexOf('@media (min-width:' + w + ')')
    return i < 0 ? '' : css.slice(i, css.indexOf('\n}', i) + 2)
  }

  it('base #app max-width stays 560px (#101 regression guard)', () => {
    expect(rule('#app')).toContain('max-width:560px')
  })

  it('has a 768px tablet block', () => {
    expect(css).toContain('@media (min-width:768px)')
  })

  it('1024px block shows the sidebar and hides the bottom bar', () => {
    const b = block('1024px')
    expect(b).toContain('#sidebar{display:flex}')
    expect(b).toContain('#tabbar{display:none}')
  })

  it('#sidebar exists and is hidden below 1024px', () => {
    expect(css).toMatch(/#sidebar\{[^}]*display:none/)
  })

  // Issue #114: Home + Stats overview become 2-col grids at ≥1024px only.
  it('1024px block grids Home (.narrow.home) and Stats overview, mobile untouched', () => {
    const b = block('1024px')
    expect(b).toContain('.narrow.home{')
    expect(b).toContain('grid-template-columns:1fr 1fr')
    expect(b).toContain('align-items:start')
    expect(b).toContain('.narrow.home>.hdr{grid-column:1/-1}')
    expect(b).toContain('[data-testid="stats-overview-tab"]{display:grid')
    expect(b).toContain('[data-testid="stats-overview-tab"]>.tiles{grid-column:1/-1}')
  })

  // Issue #115: Plan/Library/History desktop layouts. 768px grids stay as the
  // week-schedule/routines and exercise/history 2-col layouts; at ≥1024px the
  // equipment chips row wraps instead of clipping; mobile base is untouched.
  it('768px block keeps the .cols and #app .list 2-col grids', () => {
    const b = block('768px')
    expect(b).toContain('.cols{display:grid;grid-template-columns:1fr 1fr')
    expect(b).toContain('#app .list{display:grid;grid-template-columns:1fr 1fr')
  })

  it('1024px block wraps the equipment chips row (issue #115)', () => {
    expect(block('1024px')).toContain('#app .chips{flex-wrap:wrap}')
  })

  // Issue #116: History master-detail at ≥1024px — list left, ActivityDetail side pane
  // right; sheets dock right as desktop panels. Mobile base markup stays untouched.
  it('1024px block has the .split master-detail grid and docks sheets right', () => {
    const b = block('1024px')
    expect(b).toContain('.split{display:grid;grid-template-columns:1fr minmax(0,520px)')
    expect(b).toMatch(/\.sheet\{[^}]*left:auto;right:0/)
    expect(b).toMatch(/\.mback\{[^}]*backdrop-filter:none/)
  })

  it('base .list stays a flex column and base .chips stays scrollable (mobile guards)', () => {
    expect(rule('.list')).toContain('display:flex;flex-direction:column')
    expect(rule('.chips')).toContain('overflow-x:auto')
  })
})
