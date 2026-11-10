import { t } from '../lib/i18n.js'
import { useUI } from '../store/useUI.js'
import { useStore } from '../store/useStore.js'
import { Button } from './ui.jsx'

export function ConflictDialog({ serverState, onResolve, close }) {
  const choose = choice => {
    close?.()
    onResolve?.(choice)
  }

  return (
    <div style={{ textAlign: 'center', padding: '6px 0', minWidth: 260 }}>
      <h3 style={{ marginBottom: 8 }}>{t('Sync conflict')}</h3>
      <div className="muted" style={{ marginBottom: 14, lineHeight: 1.5 }}>
        {t('Changes exist on both this device and the server. Which version do you want to keep?')}
      </div>
      <div className="small dim" style={{ marginBottom: 18, lineHeight: 1.4 }}>
        {t('Choosing the server version will create a local backup of your device data first.')}
      </div>

      <Button
        variant="primary"
        style={{ width: '100%', marginBottom: 8 }}
        onClick={() => choose('device')}
      >
        {t('Keep this device')}
      </Button>

      <Button
        variant="tinted"
        style={{ width: '100%', marginBottom: 8 }}
        onClick={() => choose('server')}
      >
        {t('Use server data')}
      </Button>

      <Button
        variant="ghost"
        className="dim"
        style={{ width: '100%' }}
        onClick={() => choose('cancel')}
      >
        {t('Cancel')}
      </Button>
    </div>
  )
}

export function openConflictDialog(opts = {}) {
  const { serverState, onResolve, autoResolve = true, locked = false } = opts
  return new Promise(resolve => {
    useUI.getState().openSheet(
      close => (
        <ConflictDialog
          serverState={serverState}
          close={close}
          onResolve={async choice => {
            close()
            if (autoResolve && (choice === 'device' || choice === 'server')) {
              await useStore.getState().resolveConflict(choice, serverState)
            }
            onResolve?.(choice)
            resolve(choice)
          }}
        />
      ),
      { kind: 'center', locked }
    )
  })
}

export const conflictDialogSheet = openConflictDialog

export default ConflictDialog
