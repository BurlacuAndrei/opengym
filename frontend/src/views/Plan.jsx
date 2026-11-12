import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { DAYN, uid, exCount } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { dayAssignSheet, loadStarterPlan, planToolsSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'
import { glyphOf, DEFAULT_GLYPH } from '../lib/glyphs.js'
import { coachAvailable } from '../lib/coach.js'
import { DEMO } from '../lib/demo.js'
import { MOBILE } from '../lib/mobile.js'
import { isImperial, distanceUnit } from '../lib/cardio-format.js'
import {
  autoLinkCardioActivities,
  formatCardioTarget,
  addCardioPlan,
  removeCardioPlan,
  updateCardioPlan
} from '../lib/cardio-plan.js'

export function CardioPlanSheet({ existing, close }) {
  const storeS = useStore(s => s.S)
  const S = (typeof window === 'undefined' ? useStore.getState().S : storeS) || storeS
  const update = useStore(s => s.update)
  const imperial = isImperial(S.unit)
  const distUnit = distanceUnit(S.unit)

  const [type, setType] = useState(existing?.type || 'run')
  const [day, setDay] = useState(existing?.day != null ? String(existing.day) : '1')
  const [distance, setDistance] = useState(() => {
    if (!existing?.targetDistanceM) return ''
    const val = imperial ? existing.targetDistanceM / 1609.344 : existing.targetDistanceM / 1000
    return String(Math.round(val * 100) / 100)
  })
  const [duration, setDuration] = useState(() => {
    if (!existing?.targetDurationMs) return ''
    return String(Math.round(existing.targetDurationMs / 60000))
  })
  const [notes, setNotes] = useState(existing?.notes || '')

  const onSave = () => {
    const numDist = parseFloat(distance)
    const targetDistanceM = !isNaN(numDist) && numDist > 0
      ? (imperial ? numDist * 1609.344 : numDist * 1000)
      : null

    const numDur = parseFloat(duration)
    const targetDurationMs = !isNaN(numDur) && numDur > 0
      ? numDur * 60000
      : null

    const planData = {
      type,
      day: parseInt(day, 10),
      targetDistanceM,
      targetDurationMs,
      notes: notes.trim()
    }

    update(s => {
      if (existing) {
        updateCardioPlan(s, existing.id, planData)
      } else {
        addCardioPlan(s, planData)
      }
    })
    close()
  }

  const onDelete = () => {
    if (existing) {
      update(s => {
        removeCardioPlan(s, existing.id)
      })
    }
    close()
  }

  return (
    <div className="cardio-plan-sheet" style={{ padding: '4px 0' }}>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>
          {existing ? t('Edit cardio target') : t('Schedule cardio target')}
        </h3>
        <button type="button" className="iconbtn" onClick={close} aria-label={t('Close')}>
          <Icon name="xmark" />
        </button>
      </div>

      <div style={{ marginBottom: 14 }}>
        <Segmented
          options={[
            { value: 'run', label: t('Run') },
            { value: 'ride', label: t('Ride') },
            { value: 'hike', label: t('Hike') },
            { value: 'walk', label: t('Walk') }
          ]}
          value={type}
          onChange={setType}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
          {t('Day of week')}
        </label>
        <select
          className="num"
          style={{ width: '100%', padding: '8px 12px', borderRadius: 8 }}
          value={day}
          onChange={e => setDay(e.target.value)}
        >
          {[1, 2, 3, 4, 5, 6, 0].map(d => (
            <option key={d} value={d}>
              {t(DAYN[d])}
            </option>
          ))}
        </select>
      </div>

      <div className="row" style={{ gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
            {t('Distance')} ({distUnit})
          </label>
          <input
            type="number"
            step="any"
            className="num"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8 }}
            placeholder="5"
            value={distance}
            onChange={e => setDistance(e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
            {t('Duration (min)')}
          </label>
          <input
            type="number"
            step="1"
            className="num"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8 }}
            placeholder="30"
            value={duration}
            onChange={e => setDuration(e.target.value)}
          />
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label className="muted small" style={{ display: 'block', marginBottom: 4 }}>
          {t('Notes')}
        </label>
        <input
          type="text"
          className="num"
          style={{ width: '100%', padding: '8px 12px', borderRadius: 8 }}
          placeholder={t('e.g. Zone 2, intervals, recovery')}
          value={notes}
          onChange={e => setNotes(e.target.value)}
        />
      </div>

      <div className="row" style={{ gap: 8 }}>
        {existing && (
          <Button variant="tinted" icon="trash" onClick={onDelete}>
            {t('Delete')}
          </Button>
        )}
        <div className="grow" />
        <Button variant="plain" onClick={close}>
          {t('Cancel')}
        </Button>
        <Button variant="primary" icon="check" onClick={onSave}>
          {t('Save')}
        </Button>
      </div>
    </div>
  )
}

export default function Plan() {
  const nav = useNavigate()
  const storeS = useStore(s => s.S)
  const S = (typeof window === 'undefined' ? useStore.getState().S : storeS) || storeS
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const update = useStore(s => s.update)
  const coachOn = coachAvailable(config, user, { demo: DEMO, mobile: MOBILE })

  // Automatic same-day activity linking for planned cardio sessions
  useEffect(() => {
    update(s => {
      autoLinkCardioActivities(s)
    })
  }, [S.cardioActivities?.length])

  const addRoutine = () => {
    const r = { id: uid(), name: t('New routine'), emoji: DEFAULT_GLYPH, kind: 'gym', ex: [] }
    update(s => { s.routines.push(r) })
    nav('/plan/r/' + r.id)
  }

  const openCardioSheet = (existing = null) => {
    useUI.getState().openSheet(close => <CardioPlanSheet existing={existing} close={close} />)
  }

  const cardioPlans = S.cardioPlans || []

  return <>
    <div className="hdr">
      <div><h1>{t('Plan')}</h1><div className="sub">{t('Your weekly routine')}</div></div>
      {coachOn && <button className="iconbtn" onClick={() => nav('/coach')} aria-label={t('Coach')} title={t('Coach')}><Icon name="sparkles" /></button>}
      <button className="iconbtn" onClick={planToolsSheet} aria-label={t('Share your plan')} title={t('Share your plan')}><Icon name="upload" /></button>
    </div>
    <div className="cols"><div>
      <h4 className="sec">{t('Week schedule')}</h4>
      <div className="list" style={{ display: 'flex', flexDirection: 'column' }}>
        {[1, 2, 3, 4, 5, 6, 0].map(d => {
          const sessionIds = Array.isArray(S.week?.[d])
            ? S.week[d]
            : (S.week?.[d] ? [S.week[d]] : [])
          const dayRoutines = S.routines.filter(x => sessionIds.includes(x.id) || S.week?.[d] === x.id)
          const dayCardio = cardioPlans.filter(c => c.day === d || sessionIds.includes(c.id))
          const hasActivities = dayRoutines.length > 0 || dayCardio.length > 0

          return <div key={d} className="item" onClick={() => dayAssignSheet(d)}>
            <div className="grow"><div className="tt">{t(DAYN[d])}</div></div>
            {hasActivities ? (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {dayRoutines.map(r => (
                  <span key={r.id} className="tag acc">
                    <Icon name={glyphOf(r.emoji)} />{r.name}
                  </span>
                ))}
                {dayCardio.map(c => (
                  <span key={c.id} className={'tag ' + (c.completed ? 'acc' : '')}>
                    <Icon name={c.type === 'ride' ? 'bike' : 'figureRun'} />
                    {formatCardioTarget(c, S.unit)}
                    {c.completed && <Icon name="check" style={{ marginLeft: 4 }} />}
                  </span>
                ))}
              </div>
            ) : (
              <span className="tag">{t('Rest')}</span>
            )}
            <Icon name="chevronRight" className="chev" />
          </div>
        })}
      </div>
    </div><div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h4 className="sec" style={{ margin: 0 }}>{t('Routines')}</h4>
        <Button size="sm" variant="tinted" icon="plus" onClick={addRoutine}>{t('New')}</Button>
      </div>
      {S.routines.length ? <div className="list">{S.routines.map(r => <div key={r.id} className="item" onClick={() => nav('/plan/r/' + r.id)}>
        <span className="lrow-i"><Icon name={glyphOf(r.emoji)} /></span>
        <div className="grow"><div className="tt">{r.name}</div><div className="ss">{exCount(r.ex.length)}</div></div>
        <Icon name="chevronRight" className="chev" /></div>)}</div> : <>
        <div className="empty"><div className="ico"><Icon name="clipboard" /></div>{t('No routines yet.')}<br />{t('Create one or load the starter plan.')}</div>
        <Button icon="sparkles" onClick={loadStarterPlan}>{t('Load starter plan (Push / Pull / Legs)')}</Button>
      </>}

      <div className="row between" style={{ marginTop: 22, marginBottom: 10 }}>
        <h4 className="sec" style={{ margin: 0 }}>{t('Cardio targets')}</h4>
        <Button size="sm" variant="tinted" icon="plus" onClick={() => openCardioSheet()}>{t('New')}</Button>
      </div>
      {cardioPlans.length ? (
        <div className="list">
          {cardioPlans.map(cp => (
            <div key={cp.id} className="item" onClick={() => openCardioSheet(cp)}>
              <span className="lrow-i"><Icon name={cp.type === 'ride' ? 'bike' : 'figureRun'} /></span>
              <div className="grow">
                <div className="tt">
                  {cp.day != null ? t(DAYN[cp.day]) : t('Any day')} · {formatCardioTarget(cp, S.unit)}
                </div>
                <div className="ss">
                  {cp.notes ? cp.notes + ' · ' : ''}
                  {cp.completed ? (
                    <span style={{ color: 'var(--acc)', fontWeight: 600 }}>{t('Completed')}</span>
                  ) : (
                    t('Scheduled')
                  )}
                </div>
              </div>
              {cp.completed ? <Icon name="check" className="accent" /> : <Icon name="chevronRight" className="chev" />}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty" style={{ padding: '16px 0', fontSize: 13 }}>
          <div className="ico"><Icon name="figureRun" /></div>
          {t('No cardio scheduled yet.')}<br />
          {t('Schedule weekly cardio sessions with distance and duration targets.')}
        </div>
      )}
    </div></div>
  </>
}
