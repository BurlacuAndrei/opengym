import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { fmtDate, fmtDur } from '../lib/format.js'
import { fmtDist, fmtPace, formatSpeed, defaultRateMetric } from '../lib/cardio-format.js'
import { unifiedHistory } from '../lib/history.js'
import { WorkoutRow, workoutDetailSheet } from '../sheets.jsx'
import { openManualCardioSheet } from '../components/ManualCardioSheet.jsx'
import Icon from '../components/Icon.jsx'

export default function History() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const [filter, setFilter] = useState('all')

  const items = unifiedHistory(S, filter)
  const totalCount = (S.workouts || []).length + (S.cardioActivities || []).length
  const hasCardio = !!(S.cardioActivities && S.cardioActivities.length)

  return <>
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/stats')} aria-label={t('Stats')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 12 }}>
        <h1>{t('History')}</h1>
        <div className="sub">
          {hasCardio
            ? t('{0} activities', totalCount)
            : t(S.workouts.length === 1 ? '{0} workout' : '{0} workouts', S.workouts.length)}
        </div>
      </div>
    </div>

    {hasCardio && (
      <div className="row" style={{ gap: 8, padding: '0 16px 12px 16px' }}>
        <button
          type="button"
          className={'btn ' + (filter === 'all' ? 'primary' : 'plain')}
          style={{ padding: '4px 12px', fontSize: 13, height: 28 }}
          onClick={() => setFilter('all')}
        >
          {t('All')}
        </button>
        <button
          type="button"
          className={'btn ' + (filter === 'workout' ? 'primary' : 'plain')}
          style={{ padding: '4px 12px', fontSize: 13, height: 28 }}
          onClick={() => setFilter('workout')}
        >
          {t('Workouts')}
        </button>
        <button
          type="button"
          className={'btn ' + (filter === 'cardio' ? 'primary' : 'plain')}
          style={{ padding: '4px 12px', fontSize: 13, height: 28 }}
          onClick={() => setFilter('cardio')}
        >
          {t('Cardio')}
        </button>
      </div>
    )}

    {items.length ? (
      <div className="list">
        {items.map(item => {
          if (item.entryType === 'cardio') {
            const metric = defaultRateMetric(item.cardioType)
            const rateBadge = metric === 'speed'
              ? (item.avgSpeedKmh ? formatSpeed(item.avgSpeedKmh, S.unit) : null)
              : (item.avgPaceSecKm ? fmtPace(item.avgPaceSecKm, S.unit) : null)

            return (
              <div
                key={item.id}
                className="item"
                onClick={() => openManualCardioSheet({ ...item, type: item.cardioType || item.sport || item.type })}
              >
                <span className="lrow-i" style={{ width: 34, height: 34, borderRadius: 8, fontSize: 19 }}>
                  <Icon name={item.cardioType === 'ride' ? 'bike' : 'figureRun'} />
                </span>
                <div className="grow">
                  <div className="tt" style={{ textTransform: 'capitalize' }}>
                    {t(item.cardioType || 'Cardio')}
                  </div>
                  <div className="ss">
                    {[
                      fmtDate(item.d, true),
                      fmtDur(item.durationMs),
                      item.distanceM > 0 ? fmtDist(item.distanceM, S.unit) : null,
                      rateBadge
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Icon name="chevronRight" className="chev" />
              </div>
            )
          }
          return <WorkoutRow key={item.id} w={item} onClick={() => workoutDetailSheet(item)} />
        })}
      </div>
    ) : (
      <div className="empty">
        <div className="ico"><Icon name="history" /></div>
        {t(filter === 'cardio' ? 'No cardio activities yet.' : filter === 'workout' ? 'No workouts yet.' : 'No workouts yet.')}
      </div>
    )}
  </>
}
