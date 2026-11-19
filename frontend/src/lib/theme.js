export const THEME_COLORS = { light: '#F6F6F3', dark: '#111315' }

/**
 * Resolves a theme preference ('system' | 'light' | 'dark') to 'light' or 'dark'.
 * Falls back safely to 'dark' for missing/invalid preferences or non-browser environments.
 */
export function resolveTheme(pref, mql) {
  if (pref === 'light' || pref === 'dark') return pref
  if (pref === 'system') {
    const query = mql !== undefined
      ? mql
      : (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)')
          : null)
    return query ? (query.matches ? 'dark' : 'light') : 'dark'
  }
  return 'dark'
}

/**
 * Applies the resolved theme to <html data-theme> and <meta name="theme-color">.
 */
export function applyTheme(pref, mql) {
  const resolved = resolveTheme(pref, mql)
  if (typeof document !== 'undefined') {
    if (document.documentElement) document.documentElement.dataset.theme = resolved
    const meta = document.querySelector?.('meta[name="theme-color"]')
    if (meta) meta.content = THEME_COLORS[resolved]
  }
  return resolved
}
