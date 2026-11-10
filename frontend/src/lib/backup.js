export const BACKUP_PREFIX = 'gym_backup_'
export const LATEST_BACKUP_KEY = 'gym_backup_latest'

export function createLocalBackup(state, timestamp = Date.now()) {
  let target = state
  if (!target && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem('gym_state_v1')
      if (raw) target = JSON.parse(raw)
    } catch {}
  }
  if (!target) return null

  const ts = typeof timestamp === 'number' ? timestamp : Date.now()
  const key = `${BACKUP_PREFIX}${ts}`
  const backup = {
    version: 1,
    timestamp: ts,
    date: new Date(ts).toISOString(),
    state: JSON.parse(JSON.stringify(target))
  }
  const payload = JSON.stringify(backup)
  try {
    localStorage.setItem(key, payload)
    localStorage.setItem(LATEST_BACKUP_KEY, payload)
    return { key, ...backup }
  } catch (e) {
    return null
  }
}

export const saveLocalBackup = createLocalBackup
export const createBackup = createLocalBackup

export function getLatestBackup() {
  try {
    const raw = localStorage.getItem(LATEST_BACKUP_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  const list = getLocalBackups()
  return list[0] || null
}

export function getLocalBackups() {
  const backups = []
  try {
    const keys = typeof localStorage.key === 'function'
      ? Array.from({ length: localStorage.length || 0 }, (_, i) => localStorage.key(i))
      : (localStorage._store ? Object.keys(localStorage._store) : [])
    for (const key of keys) {
      if (key && key.startsWith(BACKUP_PREFIX)) {
        try {
          const item = JSON.parse(localStorage.getItem(key))
          backups.push({ key, ...item })
        } catch {}
      }
    }
  } catch {}
  return backups.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
}

export function restoreLocalBackup(keyOrBackup) {
  let backup = keyOrBackup
  if (typeof keyOrBackup === 'string') {
    try {
      backup = JSON.parse(localStorage.getItem(keyOrBackup))
    } catch {
      return null
    }
  }
  return backup?.state || null
}

export function clearLocalBackups() {
  try {
    const keys = typeof localStorage.key === 'function'
      ? Array.from({ length: localStorage.length || 0 }, (_, i) => localStorage.key(i))
      : (localStorage._store ? Object.keys(localStorage._store) : [])
    for (const key of keys) {
      if (key && (key.startsWith(BACKUP_PREFIX) || key === LATEST_BACKUP_KEY)) {
        localStorage.removeItem(key)
      }
    }
  } catch {}
}
