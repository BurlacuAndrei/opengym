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
