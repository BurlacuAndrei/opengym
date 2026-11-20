import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { effectiveDaySessions } from '../lib/history.js'
import { todayISO, exCount } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { nav } from '../lib/nav.js'
import { startFlow } from '../sheets.jsx'
import { isFlowRoutine } from '../lib/flow-player.js'
import { getRoutineKind, ROUTINE_KIND_LABELS, ROUTINE_KIND_ICONS } from '../lib/routine-kind.js'
import { formatCardioTarget } from '../lib/cardio-plan.js'
import { glyphOf } from '../lib/glyphs.js'
import { openManualCardioSheet } from './ManualCardioSheet.jsx'
import { openFreestyleLoggerSheet } from './FreestyleLoggerSheet.jsx'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

export function getPendingDaySessions(S, isoDate = todayISO()) {
  const day = effectiveDaySessions(S, isoDate)
  const completedRoutineIds = new Set(
    (day.completed || []).filter(c => c && c.routineId).map(c => c.routineId)
  )
  const pendingRoutines = (day.routines || []).filter(r => r && !completedRoutineIds.has(r.id))
  const pendingCardio = (day.cardioPlans || []).filter(cp => cp && !cp.completed)
  return { pendingRoutines, pendingCardio }
}

export default function StartHubSheet({ close, onNavigate, initialView = 'hub' }) {
  const S = useStore(s => s.S)
  const [view, setView] = useState(initialView) // 'hub' | 'strength' | 'flow'

  let routerNav = null
  try {
    routerNav = useNavigate()
  } catch {
    // Router context optional in standalone renders
  }

  const go = (to, opts) => {
    if (onNavigate) onNavigate(to, opts)
    else if (routerNav) routerNav(to, opts)
    else nav(to, opts)
  }

  const { pendingRoutines, pendingCardio } = getPendingDaySessions(S, todayISO())
  const hasPlanned = pendingRoutines.length > 0 || pendingCardio.length > 0

  const routines = Array.isArray(S?.routines) ? S.routines : []
  const gymRoutines = routines.filter(r => getRoutineKind(r) === 'gym')
  const flowRoutines = routines.filter(r => isFlowRoutine(r))

  const launchRoutine = routineId => {
    close?.()
    startFlow(routineId)
  }

  const launchCardioPlan = cp => {
    close?.()
    go('/record', { state: { activityType: cp.type, cardioPlanId: cp.id } })
  }

  if (view === 'strength') {
    return (
      <div data-testid="start-hub-strength">
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            className="iconbtn"
            aria-label={t('Back')}
            onClick={() => setView('hub')}
          >
            <Icon name="chevronLeft" />
          </button>
          <h3 style={{ margin: 0 }}>{t('Start Strength Workout')}</h3>
        </div>

        {gymRoutines.length > 0 ? (
          <div className="list" style={{ marginBottom: 12 }}>
            {gymRoutines.map(r => (
              <button
                key={r.id}
                type="button"
                className="item"
                onClick={() => launchRoutine(r.id)}
              >
                <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
                <div className="grow">
                  <div className="tt">{r.name}</div>
                  <div className="ss">{exCount(r.ex?.length || 0)}</div>
                </div>
                <Icon name="chevronRight" className="chev" />
              </button>
            ))}
          </div>
        ) : (
          <div className="muted small" style={{ marginBottom: 12 }}>
            {t('No gym routines yet')}
          </div>
        )}

        <Button
          variant="primary"
          icon="shuffle"
          onClick={() => launchRoutine(null)}
        >
          {t('Freestyle workout (pick as you go)')}
        </Button>
      </div>
    )
  }

  if (view === 'flow') {
    return (
      <div data-testid="start-hub-flow">
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            className="iconbtn"
            aria-label={t('Back')}
            onClick={() => setView('hub')}
          >
            <Icon name="chevronLeft" />
          </button>
          <h3 style={{ margin: 0 }}>{t('Start Guided Flow')}</h3>
        </div>

        {flowRoutines.length > 0 ? (
          <div className="list">
            {flowRoutines.map(r => {
              const kind = getRoutineKind(r)
              return (
                <button
                  key={r.id}
                  type="button"
                  className="item"
                  onClick={() => launchRoutine(r.id)}
                >
                  <span className="lrow-i"><Icon name={ROUTINE_KIND_ICONS[kind] || 'sparkles'} /></span>
                  <div className="grow">
                    <div className="tt">{r.name}</div>
                    <div className="ss">{ROUTINE_KIND_LABELS[kind]} · {exCount(r.ex?.length || 0)}</div>
                  </div>
                  <Icon name="chevronRight" className="chev" />
                </button>
              )
            })}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div className="muted small" style={{ marginBottom: 12 }}>
              {t('No flow routines yet')}
            </div>
            <Button variant="primary" onClick={() => { close?.(); go('/plan') }}>
              {t('Create a routine in Plan')}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-testid="start-hub-sheet">
      <h3>{t('Start a session')}</h3>

      {hasPlanned && (
        <div style={{ marginBottom: 16 }} data-testid="start-hub-planned">
          <h4 className="sec" style={{ marginTop: 0 }}>{t("Today's plan")}</h4>
          <div className="list">
            {pendingRoutines.map(r => {
              const kind = getRoutineKind(r)
              return (
                <button
                  key={r.id}
                  type="button"
                  className="item"
                  style={{ borderColor: 'var(--acc)' }}
                  onClick={() => launchRoutine(r.id)}
                  data-testid={`planned-routine-${r.id}`}
                >
                  <span className="lrow-i"><Icon name={glyphOf(r.emoji) || ROUTINE_KIND_ICONS[kind]} /></span>
                  <div className="grow">
                    <div className="tt">{r.name}</div>
                    <div className="ss">{ROUTINE_KIND_LABELS[kind]} · {exCount(r.ex?.length || 0)}</div>
                  </div>
                  <span className="tag acc">{t('Start')}</span>
                </button>
              )
            })}
            {pendingCardio.map(cp => (
              <button
                key={cp.id}
                type="button"
                className="item"
                style={{ borderColor: 'var(--acc)' }}
                onClick={() => launchCardioPlan(cp)}
                data-testid={`planned-cardio-${cp.id}`}
              >
                <span className="lrow-i"><Icon name={cp.type === 'ride' ? 'bike' : 'figureRun'} /></span>
                <div className="grow">
                  <div className="tt">{formatCardioTarget(cp, S?.unit)}</div>
                  {cp.notes && <div className="ss">{cp.notes}</div>}
                </div>
                <span className="tag acc">{t('Start')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <h4 className="sec" style={{ marginTop: hasPlanned ? 8 : 0 }}>{t('Quick launch')}</h4>
      <div className="list">
        <button
          type="button"
          className="item"
          data-testid="quick-action-gps-cardio"
          onClick={() => { close?.(); go('/record') }}
        >
          <span className="lrow-i"><Icon name="figureRun" /></span>
          <div className="grow">
            <div className="tt">{t('Record GPS Cardio')}</div>
            <div className="ss">{t('GPS-tracked run, ride, walk, or hike')}</div>
          </div>
          <Icon name="chevronRight" className="chev" />
        </button>

        <button
          type="button"
          className="item"
          data-testid="quick-action-strength"
          onClick={() => setView('strength')}
        >
          <span className="lrow-i"><Icon name="dumbbell" /></span>
          <div className="grow">
            <div className="tt">{t('Start Strength Workout')}</div>
            <div className="ss">{t('Pick a gym routine or start freestyle')}</div>
          </div>
          <Icon name="chevronRight" className="chev" />
        </button>

        <button
          type="button"
          className="item"
          data-testid="quick-action-flow"
          onClick={() => setView('flow')}
        >
          <span className="lrow-i"><Icon name="sparkles" /></span>
          <div className="grow">
            <div className="tt">{t('Start Guided Flow')}</div>
            <div className="ss">{t('Timed HIIT, Yoga, or Mobility routine')}</div>
          </div>
          <Icon name="chevronRight" className="chev" />
        </button>

        <button
          type="button"
          className="item"
          data-testid="quick-action-manual-cardio"
          onClick={() => { close?.(); openManualCardioSheet() }}
        >
          <span className="lrow-i"><Icon name="clock" /></span>
          <div className="grow">
            <div className="tt">{t('Log Manual Cardio')}</div>
            <div className="ss">{t('Log a past run, ride, walk, or hike')}</div>
          </div>
          <Icon name="chevronRight" className="chev" />
        </button>

        <button
          type="button"
          className="item"
          data-testid="quick-action-freestyle"
          onClick={() => { close?.(); openFreestyleLoggerSheet() }}
        >
          <span className="lrow-i"><Icon name="timer" /></span>
          <div className="grow">
            <div className="tt">{t('Log Freestyle Session')}</div>
            <div className="ss">{t('Timed HIIT, Yoga, or Mobility session')}</div>
          </div>
          <Icon name="chevronRight" className="chev" />
        </button>
      </div>
    </div>
  )
}

export function openStartHubSheet(opts = {}) {
  return useUI.getState().openSheet(close => <StartHubSheet {...opts} close={close} />)
}
