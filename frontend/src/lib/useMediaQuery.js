import { useEffect, useState } from 'react'

// SSR / no-matchMedia safe: defaults to false so the mobile layout stays the
// base; only a real matching query flips a desktop layout on.
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? Boolean(window.matchMedia(query)?.matches)
      : false
  ))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    if (!mql) return
    const onChange = e => setMatches(Boolean(e && typeof e.matches === 'boolean' ? e.matches : mql.matches))
    setMatches(Boolean(mql.matches))
    // Safari < 14 has no addEventListener on media query lists — same fallback as theme.js
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange)
      return () => mql.removeListener(onChange)
    }
  }, [query])

  return matches
}
