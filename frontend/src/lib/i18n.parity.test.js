// Locale parity: every i18n key used in source (t('…') calls, muscle names,
// month abbreviations) must exist in each locale file, and every {0}-style
// placeholder must survive translation verbatim, same count.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import de from '../locales/de.js'
import es from '../locales/es.js'
import fr from '../locales/fr.js'
import hi from '../locales/hi.js'
import itLocale from '../locales/it.js'
import ko from '../locales/ko.js'
import pl from '../locales/pl.js'
import pt from '../locales/pt.js'
import ru from '../locales/ru.js'
import tr from '../locales/tr.js'
import zh from '../locales/zh.js'

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const T_CALL = /\bt\((['"])((?:\\.|(?!\1)[^\\\n])*)\1/g
const PLACEHOLDER = /\{(\d+)\}/g
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Mirrors the extraction rules: all t('…') literals outside tests, locales/ and
// instr/, plus the MUSCLE_NAME display names that double as i18n keys.
function extractSourceKeys() {
  const keys = new Set()
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name === 'locales' || e.name === 'instr') continue; walk(p) }
      else if (/\.(js|jsx)$/.test(e.name) && !/\.test\./.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(T_CALL))
          keys.add(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
      }
    }
  }
  walk(srcDir)
  const muscles = fs.readFileSync(path.join(srcDir, 'lib/muscles.js'), 'utf8')
  const head = muscles.slice(muscles.indexOf('MUSCLE_NAME'))
  let depth = 0, end = head.indexOf('{')
  for (let j = end; j < head.length; j++) {
    if (head[j] === '{') depth++
    if (head[j] === '}') { depth--; if (!depth) { end = j; break } }
  }
  for (const m of head.slice(head.indexOf('{'), end + 1).matchAll(/:\s*'((?:\\.|[^'\\\n])*)'/g)) keys.add(m[1])
  for (const mo of MONTHS) keys.add(mo)
  return keys
}

const counts = s => [...s.matchAll(PLACEHOLDER)].map(m => m[1]).sort().join(',')

describe('locale key parity', () => {
  const sourceKeys = extractSourceKeys()
  const locales = { de, es, fr, hi, it: itLocale, ko, pl, pt, ru, tr, zh }

  it('source extraction finds keys', () => {
    expect(sourceKeys.size).toBeGreaterThan(500)
  })

  for (const [lang, dict] of Object.entries(locales)) {
    it(`${lang}: every source key is translated`, () => {
      expect([...sourceKeys].filter(k => !(k in dict))).toEqual([])
    })

    it(`${lang}: placeholders survive translation`, () => {
      for (const k of sourceKeys) {
        if (!(k in dict)) continue
        expect(counts(dict[k])).toBe(counts(k))
      }
    })
  }
})
