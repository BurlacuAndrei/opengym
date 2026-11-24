import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { getCardioRecorder, RECORDING_STATUS } from '../lib/cardio-recording.js'
import { getActiveFlow, subscribeActiveFlow } from '../lib/flow-player.js'
import { ROUTINE_KIND_ICONS } from '../lib/routine-kind.js'
import { openStartHubSheet } from './StartHubSheet.jsx'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'

export function resolveTabBarResume({ S, cardioState, activeFlow }) {
  const isWorkoutActive = Boolean(S?.active)
  const isCardioActive =
    cardioState?.status === RECORDING_STATUS.RECORDING ||
    cardioState?.status === RECORDING_STATUS.PAUSED
  const isFlowActive = Boolean(activeFlow && activeFlow.routineId && !activeFlow.state?.isCompleted)

  if (isWorkoutActive) {
    return { target: '/workout', icon: 'dumbbell' }
  }
  if (isCardioActive) {
    return {
      target: '/record',
      icon: cardioState?.activityType === 'ride' ? 'bike' : 'figureRun',
    }
  }
  if (isFlowActive) {
    return {
      target: '/flow/' + activeFlow.routineId,
      icon: ROUTINE_KIND_ICONS[activeFlow.kind] || 'sparkles',
    }
  }
  return null
}

export default function TabBar() {
  const nav = useNavigate()
  const loc = useLocation()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const isGuest = useStore(s => s.isGuest())

  const [cardioState, setCardioState] = useState(() => getCardioRecorder().getState())
  const [activeFlow, setActiveFlow] = useState(() => getActiveFlow())

  useEffect(() => {
    const rec = getCardioRecorder()
    setCardioState(rec.getState())
    const unsubCardio = rec.subscribe(st => setCardioState({ ...st }))
    setActiveFlow(getActiveFlow())
    const unsubFlow = subscribeActiveFlow(flow => setActiveFlow(flow))
    return () => {
      if (typeof unsubCardio === 'function') unsubCardio()
      if (typeof unsubFlow === 'function') unsubFlow()
    }
  }, [])

  if (!user && !isGuest) return null
  const cur = loc.pathname.split('/')[1] || 'home'
  const on = k => cur === k || (cur === 'history' && k === 'stats') || (cur === 'privacy' && k === 'settings') || (cur === 'settings' && k === 'home')

  const resume = resolveTabBarResume({ S, cardioState, activeFlow })
  const resumeTarget = resume?.target || null
  const resumeIcon = resume?.icon || 'dumbbell'

  const handleCenterClick = () => {
    if (resumeTarget) {
      nav(resumeTarget)
      return
    }
    openStartHubSheet()
  }

  // `active` lets the sidebar light a tab without the bottom-bar aliases above
  // (e.g. on /settings the bottom bar falls back to Home, the sidebar to Settings).
  const Tab = ({ k, icon, to, label, active }) => (
    <button className={(active ?? on(k)) ? 'on' : ''} onClick={() => nav(to)}>
      <Icon name={icon} /><span>{label}</span>
    </button>
  )
  const Start = () => (
    <button className={'start' + (resumeTarget ? ' rec' : '')} onClick={handleCenterClick}>
      <span className="cir"><Icon name={resumeTarget ? resumeIcon : 'dumbbell'} /></span>
      <span>{resumeTarget ? t('Resume') : t('Start')}</span>
    </button>
  )

  return (
    <>
      <nav id="tabbar">
        <Tab k="home" icon="house" to="/home" label={t('Home')} />
        <Tab k="plan" icon="calendar" to="/plan" label={t('Plan')} />
        <Start />
        <Tab k="stats" icon="chart" to="/stats" label={t('Stats')} />
        <Tab k="library" icon="list" to="/library" label={t('Library')} />
      </nav>
      <nav id="sidebar">
        <Tab k="home" icon="house" to="/home" label={t('Home')} active={cur === 'home'} />
        <Tab k="plan" icon="calendar" to="/plan" label={t('Plan')} />
        <Tab k="stats" icon="chart" to="/stats" label={t('Stats')} />
        <Tab k="library" icon="list" to="/library" label={t('Library')} />
        <Tab k="settings" icon="gear" to="/settings" label={t('Settings')} />
        <Start />
      </nav>
    </>
  )
}
