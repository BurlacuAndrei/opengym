import { Capacitor, registerPlugin } from '@capacitor/core'

export const THEME_COLORS = { light: '#F6F6F3', dark: '#111315' }
export const ACCENTS = { lime: '#30d158', sky: '#0a84ff', orange: '#ff9f0a', violet: '#bf5af2', pink: '#ff375f', red: '#ff453a', teal: '#40c8e0', gold: '#ffd60a' }

let systemBarsPlugin

function getSystemBarsPlugin() {
  if (systemBarsPlugin !== undefined) return systemBarsPlugin
  systemBarsPlugin =
    Capacitor?.Plugins?.SystemBars ||
    (typeof registerPlugin === 'function' ? registerPlugin('SystemBars') : null) ||
    null
  return systemBarsPlugin
}

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
  try {
    if (
      Capacitor?.isNativePlatform?.() &&
      Capacitor?.getPlatform?.() === 'android' &&
      (typeof Capacitor?.isPluginAvailable !== 'function' ||
        Capacitor.isPluginAvailable('SystemBars') ||
        Capacitor?.Plugins?.SystemBars)
    ) {
      const plugin = getSystemBarsPlugin()
      Promise.resolve(plugin?.setStyle?.({ theme: resolved })).catch(() => {})
    }
  } catch {}
  return resolved
}

function applyPrefs(theme, accent) {
  applyTheme(theme)
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.accent = Object.prototype.hasOwnProperty.call(ACCENTS, accent) ? accent : 'lime'
  }
}

export function syncThemeEffect(theme, accent) {
  applyPrefs(theme, accent)
  if (theme !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  if (!mql) return
  const onChange = e => applyTheme('system', e && typeof e.matches === 'boolean' ? e : mql)
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }
  if (typeof mql.addListener === 'function') {
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }
}
