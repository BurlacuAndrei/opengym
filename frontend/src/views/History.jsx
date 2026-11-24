import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { fmtDate, fmtDur } from '../lib/format.js'
import { fmtDist, fmtPaceSec, formatSpeed, defaultRateMetric } from '../lib/cardio-format.js'
import { unifiedHistory } from '../lib/history.js'
import { WorkoutRow, workoutDetailSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'

const PILLAR_META = {
  strength: { label: 'Strength', cls: 'pillar-strength', tint: 'var(--pillar-strength)' },
  cardio: { label: 'Cardio', cls: 'pillar-cardio', tint: 'var(--pillar-cardio)' },
  flow: { label: 'Flow', cls: 'pillar-flow', tint: 'var(--pillar-flow)' },
  freestyle: { label: 'Freestyle', cls: 'pillar-freestyle', tint: 'var(--pillar-freestyle)' }
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'strength', label: 'Strength' },
  { id: 'cardio', label: 'Cardio' },
  { id: 'flow', label: 'Flow & Sport' }
]

function cardioIcon(type) {
  if (type === 'ride') return 'bike'
  if (type === 'swim') return 'swim'
  return 'figureRun'
}

export default function History() {
  let nav = () => {}
  try {
    nav = useNavigate()
  } catch {}
  const S = useStore(s => s.S) || {}
  const [filter, setFilter] = useState('all')
  const normUnit = S.unit === 'lb' ? 'lbs' : (S.unit || 'kg')

  const items = unifiedHistory(S, filter)
  const totalCount = (S.workouts || []).length + (S.cardioActivities || []).length + (S.freestyleSessions || []).length

  return <>
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/stats')} aria-label={t('Stats')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 12 }}>
        <h1>{t('History')}</h1>
        <div className="sub">
          {t(totalCount === 1 ? '{0} activity' : '{0} activities', totalCount)}
        </div>
      </div>
    </div>

    <div className="chips" style={{ padding: '0 16px 12px 16px' }}>
      {FILTERS.map(f => (
        <button
          key={f.id}
          type="button"
          className={'chip' + (filter === f.id ? ' on' : '')}
          onClick={() => setFilter(f.id)}
        >
          {t(f.label)}
        </button>
      ))}
    </div>

    {items.length ? (
      <div className="list">
        {items.map(item => {
          const pMeta = PILLAR_META[item.pillar] || PILLAR_META.strength
          const badge = <span className={`pillar-badge ${pMeta.cls}`}>{t(pMeta.label)}</span>

          if (item.entryType === 'cardio') {
            const cType = item.cardioType || item.type || item.sport || 'run'
            const metric = defaultRateMetric(cType)
            const rateBadge = metric === 'speed'
              ? (item.avgSpeedKmh ? formatSpeed(item.avgSpeedKmh, normUnit) : null)
              : (fmtPaceSec(item.avgPaceSecKm, normUnit) || null)

            return (
              <div
                key={item.id}
                className="item"
                onClick={() => nav('/cardio/' + item.id)}
              >
                <span className="lrow-i" style={{ width: 34, height: 34, borderRadius: 8, fontSize: 19, '--tint': pMeta.tint }}>
                  <Icon name={cardioIcon(cType)} />
                </span>
                <div className="grow">
                  <div className="tt" style={{ textTransform: 'capitalize' }}>
                    {item.name || t(cType || 'Cardio')}
                  </div>
                  <div className="ss">
                    {[
                      fmtDate(item.d, true),
                      fmtDur(item.durationMs),
                      item.distanceM > 0 ? fmtDist(item.distanceM, normUnit) : null,
                      rateBadge
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {badge}
                <Icon name="chevronRight" className="chev" />
              </div>
            )
          }

          if (item.entryType === 'freestyle') {
            const durMs = item.durationMs || (item.durationSec ? item.durationSec * 1000 : 0)
            const icon = item.pillar === 'flow' ? 'stretch' : 'bolt'
            return (
              <div
                key={item.id}
                className="item"
                onClick={() => workoutDetailSheet(item)}
              >
                <span className="lrow-i" style={{ width: 34, height: 34, borderRadius: 8, fontSize: 19, '--tint': pMeta.tint }}>
                  <Icon name={icon} />
                </span>
                <div className="grow">
                  <div className="tt">{item.name || t(item.kind || 'Freestyle')}</div>
                  <div className="ss">
                    {[
                      fmtDate(item.d, true),
                      durMs > 0 ? fmtDur(durMs) : null,
                      item.rpe ? `RPE ${item.rpe}` : null
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {badge}
                <Icon name="chevronRight" className="chev" />
              </div>
            )
          }

          return <WorkoutRow key={item.id} w={item} badge={badge} onClick={() => workoutDetailSheet(item)} />
        })}
      </div>
    ) : (
      <div className="empty">
        <div className="ico"><Icon name="history" /></div>
        {t(filter === 'cardio' ? 'No cardio activities yet.' : filter === 'flow' ? 'No flow or freestyle sessions yet.' : 'No workouts yet.')}
      </div>
    )}
  </>
}
