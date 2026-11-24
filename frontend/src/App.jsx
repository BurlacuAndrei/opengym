import { useEffect, useRef } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { bindUI, Button } from './components/ui.jsx'
import { fmtDur } from './lib/format.js'
import { t, setLang, useLang } from './lib/i18n.js'
import { passkeyLogin } from './lib/api.js'
import { setNav, nav } from './lib/nav.js'
import { syncThemeEffect } from './lib/theme.js'
export { syncThemeEffect }
import { useWakeLock } from './lib/wakelock.js'
import {
  checkRecoveryLog,
  finishRecoveredSession,
  discardRecoveredSession
} from './lib/cardio-recovery.js'
import Icon from './components/Icon.jsx'
import TabBar from './components/TabBar.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Modals from './components/Modals.jsx'
import Toast from './components/Toast.jsx'
import RestTimer from './components/RestTimer.jsx'
import Login from './views/Login.jsx'
import Home from './views/Home.jsx'
import Plan from './views/Plan.jsx'
import RoutineEdit from './views/RoutineEdit.jsx'
import Workout from './views/Workout.jsx'
import Stats from './views/Stats.jsx'
import History from './views/History.jsx'
import Library from './views/Library.jsx'
import Settings from './views/Settings.jsx'
import PrivacySettings from './views/PrivacySettings.jsx'
import Admin from './views/Admin.jsx'
import Coach from './views/Coach.jsx'
import CoachIntake from './views/CoachIntake.jsx'
import CoachProposal from './views/CoachProposal.jsx'
import RecordingView from './views/RecordingView.jsx'
import ActivityDetail from './views/ActivityDetail.jsx'
import FlowPlayer from './views/FlowPlayer.jsx'

bindUI(useUI)   // lets the shared controls open sheets without importing the store at module scope

export function SessionExpiredBanner({ onSignIn }) {
  const handleReauth = async () => {
    if (onSignIn) { await onSignIn(); return }
    try {
      const u = await passkeyLogin()
      await useStore.getState().handleReauth(u)
      useUI.getState().toast(t('Welcome back, {0}', u.name))
    } catch (e) {
      const isCancel = e.name === 'NotAllowedError' || e.name === 'AbortError' || e.message === 'USER_CANCELLED' || e.code === 'USER_CANCELLED' || e?.message?.includes?.('USER_CANCELLED')
      if (!isCancel) useUI.getState().toast(e.message || t('Sign-in failed'))
    }
  }

  return (
    <div
      role="alert"
      className="session-expired-banner"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 100,
        background: 'var(--surface, #181B20)',
        borderBottom: '1px solid var(--sep, rgba(255,255,255,0.12))',
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--label-1)', minWidth: 0 }}>
        <span style={{ color: 'var(--yellow, #eab308)', display: 'flex', flexShrink: 0 }}><Icon name="info" /></span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('Session expired. Sign in to resume sync.')}</span>
      </div>
      <Button variant="primary" size="sm" onClick={handleReauth} style={{ flexShrink: 0 }}>
        {t('Sign in')}
      </Button>
    </div>
  )
}

export async function checkAndPromptCardioRecovery({
  checkFn = checkRecoveryLog,
  openSheetFn = fn => useUI.getState().openSheet(fn),
  finishFn = finishRecoveredSession,
  discardFn = discardRecoveredSession,
  toastFn = msg => useUI.getState().toast(msg),
  navFn = nav
} = {}) {
  const recovered = await checkFn().catch(() => null)
  if (!recovered) return null
  openSheetFn(close => (
    <>
      <h3>{t('Recover interrupted cardio?')}</h3>
      <div className="muted small" style={{ marginBottom: 14, lineHeight: 1.5 }}>
        {t(
          'Found an unfinished {0} ({1}, {2} GPS points) from an unexpected shutdown.',
          t(recovered.type || recovered.activityType || 'run'),
          fmtDur(recovered.durationMs || 0),
          recovered.points?.length || 0
        )}
      </div>
      <div className="row" style={{ gap: 10 }}>
        <Button
          variant="primary"
          style={{ flex: 1 }}
          onClick={async () => {
            try {
              const saved = await finishFn(recovered)
              close()
              toastFn(t('Cardio activity recovered and saved'))
              if (saved?.id) navFn('/cardio/' + saved.id)
            } catch {
              toastFn(t('Could not recover cardio activity'))
            }
          }}
        >
          {t('Restore & Save')}
        </Button>
        <Button
          variant="plain"
          style={{ flex: 1 }}
          onClick={async () => {
            await discardFn(recovered).catch(() => {})
            close()
            toastFn(t('Recovery log discarded'))
          }}
        >
          {t('Discard')}
        </Button>
      </div>
    </>
  ))
  return recovered
}

export function Shell() {
  const navigate = useNavigate()
  const loc = useLocation()
  const { S, user, ready, nativeReady } = useStore()
  const isGuest = useStore(s => s.isGuest())
  const sessionExpired = useStore(s => Boolean(s.sessionExpired || s.reAuthNeeded))
  const langV = useLang()   // re-renders the whole shell when the language (pack) changes
  const recoveryCheckedRef = useRef(false)
  useEffect(() => { setNav(navigate) }, [navigate])
  useEffect(() => syncThemeEffect(S.theme, S.accent), [S.theme, S.accent])
  useEffect(() => { setLang(S.lang || 'en') }, [S.lang])
  useEffect(() => { document.documentElement.lang = S.lang || 'en' }, [langV, S.lang])
  useEffect(() => {
    if (!ready || recoveryCheckedRef.current) return
    recoveryCheckedRef.current = true
    checkAndPromptCardioRecovery()
  }, [ready])
  // every tab/route change starts at the top of the page
  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])
  // bound to the workout, not to the route — checking Stats mid-session keeps the screen on
  useWakeLock(!!S.active && S.keepAwake !== false)

  const authed = user || isGuest
  if ((!ready && !authed) || !nativeReady) return (
    <div id="app">
      <div style={{ paddingTop: '44vh', display: 'flex', justifyContent: 'center', fontSize: 34, color: 'var(--label-3)' }}>
        <Icon name="dumbbell" />
      </div>
    </div>
  )

  return (
    <>
      {sessionExpired && <SessionExpiredBanner />}
      {/* keyed on the route: a view that throws is contained, and switching tabs
          re-mounts the boundary, so the tab bar is always a way out */}
      <div id="app" className="vfade" key={loc.pathname}>
        <ErrorBoundary>
          {!authed ? <Login /> : (
            <Routes>
              <Route path="/home" element={<Home />} />
              <Route path="/plan" element={<Plan />} />
              <Route path="/plan/r/:id" element={<RoutineEdit />} />
              <Route path="/workout" element={<Workout />} />
              <Route path="/flow/:id" element={<FlowPlayer />} />
              <Route path="/record" element={<RecordingView />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/history" element={<History />} />
              <Route path="/activity/:id" element={<ActivityDetail />} />
              <Route path="/cardio/:id" element={<ActivityDetail />} />
              <Route path="/library" element={<Library />} />
              <Route path="/exercises" element={<Navigate to="/library" replace />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/privacy" element={<PrivacySettings />} />
              {/* The Coach screens gate themselves on the instance config; the routes exist
                  unconditionally so a deep link from a notification lands somewhere sane
                  rather than on the catch-all. */}
              <Route path="/coach" element={<Coach />} />
              <Route path="/coach/intake" element={<CoachIntake />} />
              <Route path="/coach/proposal" element={<CoachProposal />} />
              <Route path="/admin" element={user?.admin ? <Admin /> : <Navigate to="/home" replace />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          )}
        </ErrorBoundary>
      </div>
      <TabBar />
      <RestTimer />
      <Modals />
      <Toast />
    </>
  )
}

export default function App() {
  const boot = useStore(s => s.boot)
  useEffect(() => { boot() }, [boot])
  return <HashRouter><Shell /></HashRouter>
}
