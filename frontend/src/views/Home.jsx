import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { effectiveDaySessions, unifiedHistory, streakWeeks, lastBW } from '../lib/history.js'
import { fmtNum, fmtDate, fmtDur, fmtVol, todayISO, isoOf, weekKey, DAYS } from '../lib/format.js'
import { formatCardioTarget } from '../lib/cardio-plan.js'
import { fmtDist as fmtCardioDist, fmtPaceSec, formatSpeed, defaultRateMetric } from '../lib/cardio-format.js'
import { getRoutineKind } from '../lib/routine-kind.js'
import { STARTER_PLANS, applyStarterPlan } from '../lib/starter.js'
import { t, dateLocale } from '../lib/i18n.js'
import { useUI } from '../store/useUI.js'
import { bwSheet, dayOverrideSheet, calendarSheet, startFlow, workoutDetailSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { glyphOf } from '../lib/glyphs.js'
import { coachAvailable, hasConsent } from '../lib/coach.js'
import { useCoachStatus } from '../lib/coach-api.js'
import { DEMO } from '../lib/demo.js'
import { MOBILE } from '../lib/mobile.js'

const PILLAR_STYLE = {
  strength: { label: 'Strength', cls: 'pillar-strength', tint: 'var(--pillar-strength)' },
  cardio: { label: 'Cardio', cls: 'pillar-cardio', tint: 'var(--pillar-cardio)' },
  flow: { label: 'Flow', cls: 'pillar-flow', tint: 'var(--pillar-flow)' },
  freestyle: { label: 'Freestyle', cls: 'pillar-freestyle', tint: 'var(--pillar-freestyle)' }
}

function CoachCard({ nav }) {
  const S = useStore(s => s.S)
  const { job, pending } = useCoachStatus(hasConsent(S))
  if (!hasConsent(S) || (!job && !pending)) return null
  const ready = !!pending
  return <div className="card" style={ready ? { borderColor: 'var(--acc)' } : null}>
    <button type="button" className="today-row" onClick={() => nav(ready ? '/coach/proposal' : '/coach')}>
      <div className="row" style={{ gap: 9, minWidth: 0 }}>
        <span className="lrow-i" style={{ '--tint': ready ? 'var(--acc)' : 'var(--orange)' }}><Icon name="sparkles" /></span>
        <div style={{ minWidth: 0 }}>
          <div className="lbl2">{t('Coach')}</div>
          <div className="ttl">{ready
            ? (pending.kind === 'create'
              ? t('Your plan is ready')
              : t(pending.changes?.length === 1 ? '{0} suggestion for you' : '{0} suggestions for you', pending.changes?.length || 0))
            : t('Reading your training…')}</div>
        </div>
      </div>
      {ready ? <span className="tag acc">{t('Review')}</span> : <Icon name="chevronRight" className="chev" />}
    </button>
  </div>
}

function cardioIcon(type) {
  if (type === 'ride') return 'bike'
  if (type === 'swim') return 'swim'
  return 'figureRun'
}

export default function Home() {
  let nav = () => {}
  try {
    nav = useNavigate()
  } catch {}
  const S = useStore(s => s.S) || {}
  const update = useStore(s => s.update)
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const toast = useUI(s => s.toast)
  const [weekOffset, setWeekOffset] = useState(0)
  const coachOn = coachAvailable(config, user, { demo: DEMO, mobile: MOBILE })
  const normUnit = S.unit === 'lb' ? 'lbs' : (S.unit || 'kg')

  const today = new Date()
  const todayStr = todayISO()
  const todayInfo = effectiveDaySessions(S, todayStr)
  const bw = lastBW(S)

  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + weekOffset * 7)
  const strip = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    const iso = isoOf(d)
    const info = effectiveDaySessions(S, iso)
    const done = info.completed.length > 0
    const planned = !info.isRest && (info.routines.length > 0 || info.cardioPlans.length > 0)
    const dot = done ? ' done' : (info.isOverride && planned) ? ' ovr' : planned ? ' plan' : ''
    strip.push(
      <button key={i} type="button" className={'wday' + (iso === todayStr ? ' today' : '')} onClick={() => dayOverrideSheet(iso)}>
        <div className="lbl">{t(DAYS[d.getDay()])}</div>
        <div className="num">{d.getDate()}</div>
        <div className={'dot' + dot} />
      </button>
    )
  }
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const wkLabel = weekOffset === 0
    ? t('This week')
    : `${monday.getDate()} ${monday.toLocaleDateString(dateLocale(), { month: 'short' })} – ${sunday.getDate()} ${sunday.toLocaleDateString(dateLocale(), { month: 'short' })}`

  // This Week at a Glance metrics across all pillars
  const curWk = weekKey(todayStr)
  const allHistory = unifiedHistory(S, 'all')
  const weekItems = allHistory.filter(item => item.d && weekKey(item.d) === curWk)
  const weekDurMs = weekItems.reduce((sum, item) => {
    const dur = item.durationMs || (item.durationSec ? item.durationSec * 1000 : ((item.end && item.start) ? Math.max(0, item.end - item.start) : 0))
    return sum + (dur > 0 ? dur : 0)
  }, 0)
  const weekDistM = weekItems.reduce((sum, item) => sum + (item.entryType === 'cardio' ? (Number(item.distanceM) || 0) : 0), 0)

  const recentItems = unifiedHistory(S, { filter: 'all', limit: 5 })
  const isEmptyProfile = !(S.routines || []).length && !(S.cardioPlans || []).length && !S.active
  const hasTodayScheduled = todayInfo.routines.length > 0 || todayInfo.cardioPlans.length > 0

  const handleChooseStarter = tpl => {
    update?.(s => applyStarterPlan(s, tpl.id))
    toast?.(t('{0} plan loaded', t(tpl.name)))
  }

  const todayCard = (
    <div className="card" data-testid="home-today-card">
      <div className="row between" style={{ marginBottom: 8 }}>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => setWeekOffset(w => w - 1)} aria-label="Previous week"><Icon name="chevronLeft" /></button>
        <div className="small muted" style={{ fontWeight: 500 }}>{wkLabel}</div>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => setWeekOffset(w => w + 1)} aria-label="Next week"><Icon name="chevronRight" /></button>
      </div>
      <div className="week">{strip}</div>

      <div className="row between" style={{ marginTop: 10, marginBottom: 4 }}>
        <div className="lbl2">
          {t('Today')}{todayInfo.isOverride && hasTodayScheduled ? ' · ' + t('rescheduled') : ''}
        </div>
        <Button type="button" size="sm" variant="plain" onClick={() => dayOverrideSheet(todayStr)}>
          {t('Adjust')}
        </Button>
      </div>

      {S.active && (
        <button type="button" className="today-row" onClick={() => nav('/workout')}>
          <div className="row" style={{ gap: 9, minWidth: 0 }}>
            <span className="lrow-i" style={{ '--tint': 'var(--orange)' }}>
              <Icon name="timer" />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="lbl2">{t('In progress')}</div>
              <div className="ttl">{S.active.name}</div>
            </div>
          </div>
          <span className="tag" style={{ color: 'var(--orange)', background: 'color-mix(in srgb,var(--orange) 12%,transparent)' }}>{t('Resume')}</span>
        </button>
      )}

      {hasTodayScheduled ? (
        <div className="list" style={{ margin: '4px -4px 0 -4px' }}>
          {todayInfo.routines.map(r => {
            const kind = getRoutineKind(r)
            const pKey = kind === 'gym' ? 'strength' : 'flow'
            const pMeta = PILLAR_STYLE[pKey]
            const doneToday = todayInfo.completed.some(c => c.routineId === r.id)
            return (
              <button key={r.id} type="button" className="today-row" onClick={() => startFlow(r.id)}>
                <div className="row" style={{ gap: 9, minWidth: 0 }}>
                  <span className="lrow-i" style={{ '--tint': pMeta.tint }}>
                    <Icon name={glyphOf(r.emoji)} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="ttl">{r.name}</div>
                    <span className={`pillar-badge ${pMeta.cls}`}>{t(pMeta.label)}</span>
                  </div>
                </div>
                <span className={doneToday ? 'tag' : 'tag acc'} style={doneToday ? { color: pMeta.tint, background: `color-mix(in srgb, ${pMeta.tint} 12%, transparent)` } : undefined}>
                  {doneToday ? t('Done') : t('Start')}
                </span>
              </button>
            )
          })}

          {todayInfo.cardioPlans.map(cp => {
            const pMeta = PILLAR_STYLE.cardio
            const doneToday = !!cp.completed || todayInfo.completed.some(c => c.entryType === 'cardio' && (c.cardioType === cp.type || c.type === cp.type))
            return (
              <button
                key={cp.id}
                type="button"
                className="today-row"
                onClick={() => nav('/record', { state: { activityType: cp.type || 'run', cardioPlanId: cp.id, cardioPlan: cp } })}
              >
                <div className="row" style={{ gap: 9, minWidth: 0 }}>
                  <span className="lrow-i" style={{ '--tint': pMeta.tint }}>
                    <Icon name={cardioIcon(cp.type)} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="ttl">{formatCardioTarget(cp, normUnit)}</div>
                    <span className={`pillar-badge ${pMeta.cls}`}>{t(pMeta.label)}</span>
                  </div>
                </div>
                <span className={doneToday ? 'tag' : 'tag acc'} style={doneToday ? { color: pMeta.tint, background: `color-mix(in srgb, ${pMeta.tint} 12%, transparent)` } : undefined}>
                  {doneToday ? t('Done') : t('Start')}
                </span>
              </button>
            )
          })}
        </div>
      ) : !S.active && (
        <button type="button" className="today-row" data-testid="home-rest-state" onClick={() => dayOverrideSheet(todayStr)}>
          <div className="row" style={{ gap: 9, minWidth: 0 }}>
            <span className="lrow-i" style={{ '--tint': 'var(--pillar-cardio)' }}>
              <Icon name="moon" />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="ttl">{t('Rest & Recovery')}</div>
              <div className="small muted">{t('Recovery is part of the plan — tap to adjust today.')}</div>
            </div>
          </div>
          <Icon name="plus" className="chev" />
        </button>
      )}
    </div>
  )

  return <div className="narrow home">
    <div className="hdr">
      <div>
        <h1>{user ? t('Hi {0}', user.name) : 'openGym'}</h1>
        <div className="sub">{today.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div>
      <button className="iconbtn" onClick={() => nav('/settings')} aria-label={t('Settings')}><Icon name="gear" /></button>
    </div>

    {!isEmptyProfile && todayCard}

    {coachOn && <CoachCard nav={nav} />}

    {isEmptyProfile && (
      <>
        <div className="card" data-testid="home-onboarding-chooser">
          <div className="row" style={{ gap: 10, marginBottom: 6 }}>
            <span className="lrow-i" style={{ '--tint': 'var(--acc)' }}><Icon name="sparkles" /></span>
            <div className="big" style={{ fontSize: 22 }}>{t('Welcome!')}</div>
          </div>
          <div className="muted small" style={{ marginBottom: 12 }}>
            {t('Choose a starter plan tailored to your training focus — or let the Coach build one.')}
          </div>
          {coachOn && <>
            <Button variant="primary" icon="sparkles" onClick={() => nav(hasConsent(S) ? '/coach/intake' : '/coach')}>{t('Let the Coach build it')}</Button>
            <div style={{ height: 10 }} />
          </>}
          <div className="list" style={{ margin: '0 -4px' }}>
            {STARTER_PLANS.map(tpl => (
              <button
                key={tpl.id}
                type="button"
                className="item"
                data-testid={`starter-option-${tpl.id}`}
                onClick={() => handleChooseStarter(tpl)}
              >
                <span className="lrow-i" style={{ '--tint': tpl.id === 'endurance' ? 'var(--pillar-cardio)' : tpl.id === 'mobility' ? 'var(--pillar-flow)' : 'var(--pillar-strength)' }}>
                  <Icon name={tpl.emoji} />
                </span>
                <div className="grow">
                  <div className="tt">{t(tpl.name)}</div>
                  <div className="ss">{t(tpl.description)}</div>
                </div>
                <span className="tag acc">{t('Load')}</span>
              </button>
            ))}
          </div>
          <div style={{ height: 10 }} />
          <Button onClick={() => nav('/plan')}>{t('Build my own plan')}</Button>
        </div>
        {todayCard}
      </>
    )}

    <div className="card" data-testid="home-week-glance">
      <div className="row between" style={{ marginBottom: 10, alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('This Week at a Glance')}</h2>
        <button
          type="button"
          className="tag"
          data-testid="bw-quick-pill"
          style={{
            cursor: 'pointer',
            border: 'var(--hair) solid var(--sep)',
            background: 'var(--surface-2)',
            color: 'var(--label)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '4px 10px'
          }}
          onClick={() => bwSheet()}
        >
          <Icon name="scale" style={{ fontSize: 13 }} />
          {bw ? `${fmtNum(bw.w)} ${S.unit}` : t('Log weight')}
        </button>
      </div>
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="big">{weekItems.length}</div>
          <div className="muted small">{t(weekItems.length === 1 ? 'session this week' : 'sessions this week')}</div>
        </div>
        <div>
          <div className="big">{weekDurMs > 0 ? fmtDur(weekDurMs) : '0m'}</div>
          <div className="muted small">{t('Active time')}</div>
        </div>
        {weekDistM > 0 && (
          <div>
            <div className="big">{fmtCardioDist(weekDistM, normUnit)}</div>
            <div className="muted small">{t('Distance')}</div>
          </div>
        )}
        <div className="tappable" style={{ cursor: 'pointer', textAlign: 'right' }} onClick={() => calendarSheet()}>
          <div className="row" style={{ gap: 5, fontWeight: 600, fontSize: 18 }}>
            <Icon name="flame" style={{ color: 'var(--orange)' }} />
            <span>{streakWeeks(S)}w</span>
          </div>
          <div className="muted small">{t('Streak')}</div>
        </div>
      </div>
    </div>

    <div className="card" data-testid="unified-recent-activity">
      <div className="row between" style={{ marginBottom: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('Recent Activity')}</h2>
        <Button size="sm" variant="ghost" trailingIcon="chevronRight" onClick={() => nav('/history')}>{t('History')}</Button>
      </div>
      {recentItems.length > 0 ? (
        <div className="list" style={{ margin: '0 -4px' }}>
          {recentItems.map(item => {
            const pMeta = PILLAR_STYLE[item.pillar] || PILLAR_STYLE.strength
            if (item.entryType === 'cardio') {
              const cType = item.cardioType || item.type || item.sport || 'run'
              const metric = defaultRateMetric(cType)
              const rateBadge = metric === 'speed'
                ? (item.avgSpeedKmh ? formatSpeed(item.avgSpeedKmh, normUnit) : null)
                : (fmtPaceSec(item.avgPaceSecKm, normUnit) || null)
              return (
                <div key={item.id} className="item" onClick={() => nav('/cardio/' + item.id)}>
                  <span className="lrow-i" style={{ '--tint': pMeta.tint }}><Icon name={cardioIcon(cType)} /></span>
                  <div className="grow">
                    <div className="tt" style={{ textTransform: 'capitalize' }}>{item.name || t(cType)}</div>
                    <div className="ss">
                      {[fmtDate(item.d, true), fmtDur(item.durationMs), item.distanceM > 0 ? fmtCardioDist(item.distanceM, normUnit) : null, rateBadge].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <span className={`pillar-badge ${pMeta.cls}`}>{t(pMeta.label)}</span>
                  <Icon name="chevronRight" className="chev" />
                </div>
              )
            }
            if (item.entryType === 'freestyle') {
              const durMs = item.durationMs || (item.durationSec ? item.durationSec * 1000 : 0)
              return (
                <div key={item.id} className="item" onClick={() => workoutDetailSheet(item)}>
                  <span className="lrow-i" style={{ '--tint': pMeta.tint }}><Icon name={item.pillar === 'flow' ? 'stretch' : 'bolt'} /></span>
                  <div className="grow">
                    <div className="tt">{item.name || t(item.kind || 'Freestyle')}</div>
                    <div className="ss">{[fmtDate(item.d, true), durMs > 0 ? fmtDur(durMs) : null].filter(Boolean).join(' · ')}</div>
                  </div>
                  <span className={`pillar-badge ${pMeta.cls}`}>{t(pMeta.label)}</span>
                  <Icon name="chevronRight" className="chev" />
                </div>
              )
            }
            const durMs = (item.end && item.start) ? Math.max(0, item.end - item.start) : 0
            const glyph = glyphOf((S.routines?.find(r => r.id === item.routineId) || {}).emoji)
            return (
              <div key={item.id} className="item" onClick={() => workoutDetailSheet(item)}>
                <span className="lrow-i" style={{ '--tint': pMeta.tint }}><Icon name={glyph} /></span>
                <div className="grow">
                  <div className="tt">{item.name}</div>
                  <div className="ss">{[fmtDate(item.d, true), durMs > 0 ? fmtDur(durMs) : null, item.vol > 0 ? fmtVol(item.vol, S.unit) : null].filter(Boolean).join(' · ')}</div>
                </div>
                <span className={`pillar-badge ${pMeta.cls}`}>{t(pMeta.label)}</span>
                <Icon name="chevronRight" className="chev" />
              </div>
            )
          })}
        </div>
      ) : (
        <div className="muted small">{t('Your completed workouts, runs, and flows will appear here.')}</div>
      )}
    </div>
  </div>
}
