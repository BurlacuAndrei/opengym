import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { effectiveRoutineId } from '../lib/history.js'
import { todayISO, fmtDate, fmtDur, fmtVol, MONTHS_LONG } from '../lib/format.js'
import { fmtDist } from '../lib/cardio-format.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { dayOverrideSheet, workoutDetailSheet, WorkoutRow } from '../sheets.jsx'
import { openManualCardioSheet } from './ManualCardioSheet.jsx'

export default function Calendar({ start, close }) {
  const st = useStore(s => s.S)
  const [cur, setCur] = useState(() => { const d = start ? new Date(start) : new Date(); d.setDate(1); return d })
  const y = cur.getFullYear(), mo = cur.getMonth()
  const byDay = {}

  st.workouts.forEach(w => {
    byDay[w.d] = byDay[w.d] || []
    byDay[w.d].push({ ...w, entryType: 'workout' })
  })

  ;(st.cardioActivities || []).forEach(c => {
    const d = c.d || (c.startTime ? (typeof c.startTime === 'string' && c.startTime.length >= 10 ? c.startTime.slice(0, 10) : '') : '')
    if (d) {
      byDay[d] = byDay[d] || []
      byDay[d].push({ ...c, entryType: 'cardio', d })
    }
  })

  const startOffset = (new Date(y, mo, 1).getDay() + 6) % 7
  const daysIn = new Date(y, mo + 1, 0).getDate()
  const monthWs = st.workouts.filter(w => w.d && w.d.startsWith(y + '-' + String(mo + 1).padStart(2, '0')))
  const monthCs = (st.cardioActivities || []).filter(c => {
    const d = c.d || (c.startTime ? (typeof c.startTime === 'string' && c.startTime.length >= 10 ? c.startTime.slice(0, 10) : '') : '')
    return d && d.startsWith(y + '-' + String(mo + 1).padStart(2, '0'))
  })
  const monthTotal = monthWs.length + monthCs.length
  const monthVol = monthWs.reduce((a, w) => a + (w.vol || 0), 0)
  const monthMs = monthWs.reduce((a, w) => a + Math.max(0, (w.end || w.start) - w.start), 0) +
    monthCs.reduce((a, c) => a + (c.durationMs || 0), 0)

  const cells = []
  for (let i = 0; i < startOffset; i++) cells.push(<div key={'e' + i} />)
  for (let d = 1; d <= daysIn; d++) {
    const iso = y + '-' + String(mo + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
    const items = byDay[iso], effId = effectiveRoutineId(st, iso), ovr = st.dayPlan[iso] !== undefined
    const dotCls = items && items.length ? 'done' : ovr && effId ? 'ovr' : effId ? 'plan' : ''
    cells.push(<button key={d} className={'cal-d' + (items && items.length ? ' has' : '') + (iso === todayISO() ? ' today' : '')} onClick={() => {
      if (!items || !items.length) { close(); dayOverrideSheet(iso); return }
      if (items.length === 1) {
        close()
        const single = items[0]
        if (single.entryType === 'cardio' || (!single.entries && single.durationMs)) {
          openManualCardioSheet(single)
        } else {
          workoutDetailSheet(single)
        }
        return
      }
      close()
      useUI.getState().openSheet(c2 => <>
        <h3>{fmtDate(iso, true)}</h3>
        <div className="list">
          {items.map(it => (it.entryType === 'cardio' || (!it.entries && it.durationMs))
            ? <div key={it.id} className="item" onClick={() => { c2(); openManualCardioSheet(it) }}>
                <span className="lrow-i" style={{ width: 34, height: 34, borderRadius: 8, fontSize: 19 }}>
                  <Icon name={it.cardioType === 'ride' || it.type === 'ride' ? 'bike' : 'figureRun'} />
                </span>
                <div className="grow">
                  <div className="tt" style={{ textTransform: 'capitalize' }}>{t(it.cardioType || it.type || 'Cardio')}</div>
                  <div className="ss">{[fmtDate(iso, true), fmtDur(it.durationMs), it.distanceM > 0 ? fmtDist(it.distanceM, st.unit) : null].filter(Boolean).join(' · ')}</div>
                </div>
                <Icon name="chevronRight" className="chev" />
              </div>
            : <WorkoutRow key={it.id} w={it} onClick={() => { c2(); workoutDetailSheet(it) }} />
          )}
        </div>
      </>)
    }}><span>{d}</span><i className={dotCls} /></button>)
  }

  return <>
    <div className="row between" style={{ marginBottom: 2 }}>
      <button className="iconbtn" onClick={() => setCur(new Date(y, mo - 1, 1))} aria-label="Previous month"><Icon name="chevronLeft" /></button>
      <h3 style={{ margin: 0 }}>{t(MONTHS_LONG[mo])} {y}</h3>
      <button className="iconbtn" onClick={() => setCur(new Date(y, mo + 1, 1))} aria-label="Next month"><Icon name="chevronRight" /></button>
    </div>
    <div className="small muted" style={{ textAlign: 'center' }}>
      {monthTotal
        ? `${t(monthTotal === 1 ? '{0} session' : '{0} sessions', monthTotal)} · ${fmtDur(monthMs)}${monthVol ? ' · ' + fmtVol(monthVol, st.unit) : ''}`
        : t('No workouts this month')}
    </div>
    <div className="cal-grid">{['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(l => <div key={l} className="cal-h">{t(l)}</div>)}{cells}</div>
    <div className="cal-legend">
      <span><i style={{ background: 'var(--acc)' }} />{t('Trained')}</span>
      <span><i style={{ background: 'var(--label-3)' }} />{t('Planned')}</span>
      <span><i style={{ background: 'var(--orange)' }} />{t('Rescheduled')}</span>
    </div>
    <div className="small dim" style={{ textAlign: 'center', marginTop: 10 }}>{t('Tap a trained day for details · tap any other day to plan a session')}</div>
  </>
}

export { Calendar }
