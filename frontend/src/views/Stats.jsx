import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { EXIDX } from '../lib/exercises.js'
import { lastBW, streakWeeks, setLabel, modeOf, effortOf, unifiedHistory } from '../lib/history.js'
import { fmtNum, fmtDate, fmtVol, fmtDur, todayISO, weekKey, isoOf } from '../lib/format.js'
import { fmtDist, formatElevation, distanceUnit } from '../lib/cardio-format.js'
import { calculateTrainingRhythm, sessionDate } from '../lib/training-load.js'
import { t } from '../lib/i18n.js'
import { bwSheet, goalSheet, calendarSheet, workoutDetailSheet, WorkoutRow, bwDeltaColor } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import Heatmap from '../components/Heatmap.jsx'
import Icon from '../components/Icon.jsx'
import BodyMap, { BodyMapLegend } from '../components/BodyMap.jsx'
import { loadOfWorkouts, rankOf, MUSCLE_NAME } from '../lib/muscles.js'
import { e1rmSeries, best1RM } from '../lib/onerm.js'
import {
  hasEffort, displayScale, scaleName, toScale, avgRir, effortSummary, effortWeeks,
  effortHistogram, isHardSet, HARD_RIR
} from '../lib/effort.js'
import { Button, Segmented, SelectRow } from '../components/ui.jsx'
import PrBadge from '../components/PrBadge.jsx'
import { computePersonalRecords, formatPrTime, formatPrPace } from '../lib/pr.js'

function TrainingRhythmCard({ S }) {
  const rhythm = calculateTrainingRhythm(S)
  const badgeColor =
    rhythm.statusLabel === 'Steady Rhythm' ? 'var(--pillar-strength)'
      : rhythm.statusLabel === 'Building Load' ? 'var(--orange)'
      : rhythm.statusLabel === 'High Load' ? 'var(--red)'
      : 'var(--pillar-cardio)'
  const badgeBg = `color-mix(in srgb, ${badgeColor} 12%, transparent)`
  const supportCopy =
    rhythm.totalLoad === 0
      ? 'Log a workout, cardio activity, or flow session to see your 7d/28d load rhythm.'
      : rhythm.statusLabel === 'Steady Rhythm'
      ? 'Your recent 7-day load is well balanced with your 28-day baseline.'
      : rhythm.statusLabel === 'Building Load'
      ? 'Load is trending above your 28-day baseline — weave in lighter days as needed.'
      : rhythm.statusLabel === 'High Load'
      ? 'Sharp load spike compared to your 28-day baseline — consider prioritizing recovery.'
      : 'Lighter week relative to your 28-day baseline — great space to recover or build gently.'

  return (
    <div className="card" data-testid="training-rhythm-card">
      <div className="row between" style={{ marginBottom: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('Training Rhythm')}</h2>
        <span className="tag" style={{ color: badgeColor, background: badgeBg }}>
          {t(rhythm.statusLabel)}
        </span>
      </div>
      <div className="row between" style={{ alignItems: 'flex-end', gap: 12, marginTop: 6 }}>
        <div>
          <div className="stat-v">{rhythm.totalLoad > 0 ? rhythm.acwr.toFixed(2) : '—'}</div>
          <div className="small dim">{t('7d / 28d ACWR')}</div>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 600 }}>{Math.round(rhythm.acuteTotal)} AU</div>
            <div className="small dim">{t('7d Acute')}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 600 }}>{Math.round(rhythm.chronicTotal)} AU</div>
            <div className="small dim">{t('28d Chronic')}</div>
          </div>
        </div>
      </div>
      <div className="small muted" style={{ marginTop: 10, lineHeight: 1.45 }}>
        {t(supportCopy)}
      </div>
    </div>
  )
}

function PersonalRecordsCard({ S, normUnit }) {
  const prData = computePersonalRecords(S.cardioActivities, S.personalRecords)
  const records = prData.records || {}
  const rows = [
    { target: 1000, label: '1k', name: t('1k') },
    { target: 1609.344, label: '1mi', name: t('1 mi') },
    { target: 5000, label: '5k', name: t('5k') },
    { target: 10000, label: '10k', name: t('10k') },
    { target: 21097.5, label: 'half-marathon', name: t('Half Marathon') },
    { target: 42195, label: 'marathon', name: t('Marathon') },
  ]
  const hasAnyRecord = rows.some(r => records[r.label])

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>
          {t('Personal records')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {t('cardio')}</span>
        </h2>
      </div>
      <div style={{ marginTop: 8 }}>
        {rows.map(r => {
          const rec = records[r.label]
          return (
            <div
              key={r.label}
              className="row between small"
              style={{ padding: '8px 0', borderBottom: 'var(--hair) solid var(--sep)' }}
            >
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span style={{ fontWeight: 600, minWidth: 42 }}>{r.name}</span>
                {rec && <PrBadge rank={1} label="PR" />}
              </div>
              <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                {rec ? (
                  <>
                    <span style={{ fontWeight: 600 }}>{formatPrTime(rec.elapsedTime)}</span>
                    <span className="dim">{formatPrPace(rec.elapsedTime, r.target, normUnit)}</span>
                    {(rec.d || rec.startTime) && (
                      <span className="muted">{fmtDate(rec.d || rec.startTime, true)}</span>
                    )}
                  </>
                ) : (
                  <span className="dim">—</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {!hasAnyRecord && (
        <div className="muted small" style={{ marginTop: 10 }}>
          {t('Complete a cardio activity to set personal records.')}
        </div>
      )}
    </div>
  )
}

function CardioStatsTab({ S, normUnit }) {
  const activities = Array.isArray(S.cardioActivities) ? S.cardioActivities : []
  const totalDistM = activities.reduce((sum, a) => sum + (Number(a.distanceM) || 0), 0)
  const totalDurMs = activities.reduce((sum, a) => sum + (Number(a.durationMs) || 0), 0)
  const totalElevM = activities.reduce((sum, a) => sum + (Number(a.elevationGainM) || 0), 0)

  const byWeek = new Map()
  for (const a of activities) {
    const dStr = sessionDate(a)
    if (!dStr) continue
    const wk = weekKey(dStr)
    const entry = byWeek.get(wk) || { wk, distM: 0, durMs: 0, elevM: 0, t: new Date(dStr + 'T12:00:00').getTime() }
    entry.distM += Number(a.distanceM) || 0
    entry.durMs += Number(a.durationMs) || 0
    entry.elevM += Number(a.elevationGainM) || 0
    byWeek.set(wk, entry)
  }
  const weeklyPts = [...byWeek.values()]
    .sort((a, b) => a.t - b.t)
    .slice(-12)
    .map(w => ({
      t: w.t,
      y: Math.round(((normUnit === 'lbs' ? w.distM / 1609.344 : w.distM / 1000)) * 100) / 100,
      d: isoOf(new Date(w.t)),
      note: fmtDur(w.durMs),
    }))

  const bySport = {}
  for (const a of activities) {
    const sp = a.cardioType || a.type || a.sport || 'run'
    if (!bySport[sp]) bySport[sp] = { sport: sp, count: 0, distM: 0, durMs: 0 }
    bySport[sp].count++
    bySport[sp].distM += Number(a.distanceM) || 0
    bySport[sp].durMs += Number(a.durationMs) || 0
  }
  const sportRows = Object.values(bySport).sort((a, b) => b.count - a.count)

  return (
    <div data-testid="stats-cardio-tab">
      <div className="tiles">
        <div className="tile"><div className="l"><Icon name="figureRun" />{t('Activities')}</div><div className="v">{activities.length}</div></div>
        <div className="tile"><div className="l"><Icon name="globe" />{t('Distance')}</div><div className="v" style={{ fontSize: 22 }}>{fmtDist(totalDistM, normUnit)}</div></div>
        <div className="tile"><div className="l"><Icon name="clock" />{t('Duration')}</div><div className="v" style={{ fontSize: 22 }}>{fmtDur(totalDurMs)}</div></div>
        <div className="tile"><div className="l"><Icon name="arrowUp" />{t('Elevation')}</div><div className="v" style={{ fontSize: 22 }}>{formatElevation(totalElevM, normUnit)}</div></div>
      </div>

      <div className="card">
        <h2>{t('Weekly cardio distance')}</h2>
        {weeklyPts.length > 0 ? (
          <div className="chart"><LineChart points={weeklyPts} h={160} unit={distanceUnit(normUnit)} color="var(--pillar-cardio)" /></div>
        ) : (
          <div className="muted small">{t('Complete a cardio activity to see weekly distance trends.')}</div>
        )}
      </div>

      <div className="card">
        <h2>{t('Sport breakdown')}</h2>
        {sportRows.length > 0 ? (
          <div>
            {sportRows.map(sp => (
              <div key={sp.sport} className="row between small" style={{ padding: '8px 0', borderBottom: 'var(--hair) solid var(--sep)' }}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <Icon name={sp.sport === 'ride' ? 'bike' : sp.sport === 'swim' ? 'swim' : 'figureRun'} />
                  <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{t(sp.sport)}</span>
                  <span className="pillar-badge pillar-cardio">{sp.count}</span>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <span>{sp.distM > 0 ? fmtDist(sp.distM, normUnit) : '—'}</span>
                  <span className="muted">{fmtDur(sp.durMs)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted small">{t('No cardio activities yet.')}</div>
        )}
      </div>

      <PersonalRecordsCard S={S} normUnit={normUnit} />
    </div>
  )
}

function MuscleBalance({ S }) {
  const [win, setWin] = useState(7)
  const [hard, setHard] = useState(false)
  const [sel, setSel] = useState(null)
  const now = Date.now()
  const workouts = Array.isArray(S.workouts) ? S.workouts : []
  const inWin = workouts.filter(w =>
    win === 0 ? true
      : win === 7 ? weekKey(w.d) === weekKey(todayISO())
        : (w.start || new Date(w.d).getTime()) > now - win * 86400000)
  const rated = inWin.some(w => (w.entries || []).some(e => (e.sets || []).some(s => s.done && isHardSet(s))))
  const on = hard && rated
  const load = loadOfWorkouts(inWin, on ? isHardSet : null)
  const { worked, missed } = rankOf(load)
  const top = worked.slice(0, 4)
  const max = worked.length ? load[worked[0]] : 0
  const sets = m => Math.round((load[m] || 0) * 10) / 10

  return <div className="card">
    <div className="row between" style={{ marginBottom: 8 }}>
      <h2 style={{ margin: 0 }}>{t('Muscle balance')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {on ? t('by hard sets') : t('by sets worked')}</span></h2>
      {rated && <Button size="sm" icon="flame" style={on ? { color: 'var(--yellow)' } : undefined}
        onClick={() => { setHard(h => !h); setSel(null) }}>{on ? t('Hard') : t('All')}</Button>}
    </div>
    <Segmented className="seg-range" value={win} onChange={v => { setWin(v); setSel(null) }}
      options={[{ value: 7, label: t('Week') }, { value: 30, label: '30d' }, { value: 90, label: '90d' }, { value: 0, label: t('All') }]} />
    {inWin.length ? <>
      <BodyMap className="tappable" load={load} body={S.body} selected={sel}
        onMuscle={m => setSel(s => (s === m ? null : m))} />
      <BodyMapLegend />
      {sel && <div className="mrow" style={{ borderTop: 'var(--hair) solid var(--sep)', marginTop: 4, paddingTop: 10 }}>
        <span className="nm"><b>{t(MUSCLE_NAME[sel])}</b></span>
        <span className="v">{sets(sel) ? t('{0} sets', sets(sel)) : on ? t('no hard sets') : t('not trained')}</span>
      </div>}
      {!sel && top.map(m => <div key={m} className="mrow">
        <span className="nm">{t(MUSCLE_NAME[m])}</span>
        <span className="bar"><i style={{ width: Math.round(load[m] / max * 100) + '%', background: on ? 'var(--yellow)' : undefined }} /></span>
        <span className="v">{t('{0} sets', sets(m))}</span>
      </div>)}
      {missed.length > 0 && <>
        <h4 className="sec" style={{ marginTop: 12 }}>{on ? t('No hard sets in this period') : t('Not trained in this period')}</h4>
        <div className="mchips">{missed.map(m => <span key={m} className="mchip miss">{t(MUSCLE_NAME[m])}</span>)}</div>
      </>}
      {!missed.length && worked.length > 0 &&
        <div className="muted small" style={{ marginTop: 10 }}>{on
          ? t('Every muscle group got at least one hard set in this period.')
          : t('Every muscle group got some work in this period.')}</div>}
    </> : <div className="muted small">{t('No workouts in this period yet.')}</div>}
  </div>
}

function EffortCard({ S }) {
  const [win, setWin] = useState(90)
  const kind = displayScale(S)
  const hd = scaleName(kind)
  const sum = effortSummary(S, win)
  const weeks = effortWeeks(S, win)
  const hist = effortHistogram(S, win)
  const maxBin = Math.max(1, ...hist.map(b => b.n))
  const pts = weeks.map(w => ({ t: w.t, y: toScale(kind, w.rir), note: t('{0} sets', w.sets) }))
  const binLabel = b => kind === 'rpe' ? (b.tail ? '≤ 6' : String(10 - b.rir)) : (b.tail ? b.rir + '+' : String(b.rir))

  return <div className="card">
    <h2>{t('Effort')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {t('how close to failure')}</span></h2>
    <Segmented className="seg-range" value={win} onChange={setWin}
      options={[{ value: 30, label: '30d' }, { value: 90, label: '90d' }, { value: 365, label: '1Y' }, { value: 0, label: t('All') }]} />
    {sum.rated === 0 ? <div className="muted small">{t('No rated sets in this period.')}</div> : <>
      <div className="row between" style={{ alignItems: 'flex-end', gap: 12 }}>
        <div>
          <div className="stat-v">{sum.avg == null ? '—' : fmtNum(toScale(kind, sum.avg)) + ' ' + hd}</div>
          <div className="small dim">{t('average effort')}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="stat-v" style={{ color: 'var(--yellow)' }}>{sum.hardPct == null ? '—' : Math.round(sum.hardPct * 100) + '%'}</div>
          <div className="small dim">{t('at {0} {1} or harder', hd, fmtNum(toScale(kind, HARD_RIR)))}</div>
        </div>
      </div>
      <div className="small dim" style={{ marginTop: 8 }}>{t('{0} of {1} finished sets rated', sum.rated, sum.done)}</div>
      {effortOf(S) === 'none' && <div className="small" style={{ color: 'var(--yellow)', marginTop: 4 }}>
        {t('Effort per set is switched off — turn it on in Settings to keep rating.')}
      </div>}
      {pts.length > 1 && <>
        <h4 className="sec" style={{ marginTop: 12 }}>{t('Week by week')}</h4>
        <div className="chart"><LineChart points={pts} h={140} unit={hd} color="var(--yellow)" invert={kind === 'rir'} /></div>
      </>}
      <h4 className="sec" style={{ marginTop: 12 }}>{t('Where the sets land')}</h4>
      {hist.map(b => <div key={b.rir} className="mrow">
        <span className="nm">{hd} {binLabel(b)}</span>
        <span className="bar"><i style={{ width: Math.round(b.n / maxBin * 100) + '%', background: b.rir <= HARD_RIR ? 'var(--yellow)' : 'var(--label-3)' }} /></span>
        <span className="v">{b.n ? b.n + ' · ' + Math.round(b.pct * 100) + '%' : '—'}</span>
      </div>)}
      <div className="small dim" style={{ marginTop: 8 }}>
        {t('Most working sets belong close to failure without living there — half at the floor and half at the top average out to a healthy-looking middle.')}
      </div>
    </>}
  </div>
}

function StrengthStatsTab({ S, nav }) {
  const [exId, setExId] = useState(null)
  const [exMetric, setExMetric] = useState('top')
  const workouts = Array.isArray(S.workouts) ? S.workouts : []
  const anyEffort = hasEffort(S)
  const kind = displayScale(S)
  const hd = scaleName(kind)

  const totalTonnage = workouts.reduce((sum, w) => sum + (Number(w.vol) || 0), 0)
  const volByWeek = new Map()
  for (const w of workouts) {
    if (!w.d) continue
    const wk = weekKey(w.d)
    const cur = volByWeek.get(wk) || { vol: 0, t: w.start || new Date(w.d + 'T12:00:00').getTime(), d: w.d }
    cur.vol += Number(w.vol) || 0
    volByWeek.set(wk, cur)
  }
  const tonnagePts = [...volByWeek.values()]
    .sort((a, b) => a.t - b.t)
    .slice(-12)
    .map(v => ({ t: v.t, y: Math.round(v.vol), d: v.d }))

  const exHist = [...new Set(workouts.flatMap(w => (w.entries || []).map(e => e.id)))].filter(id => EXIDX[id]).sort((a, b) => EXIDX[a].n < EXIDX[b].n ? -1 : 1)
  const curEx = exId && exHist.includes(exId) ? exId : exHist[0] || null
  const curMode = curEx ? (() => {
    for (let i = workouts.length - 1; i >= 0; i--) {
      const en = (workouts[i].entries || []).find(e => e.id === curEx)
      if (en) return modeOf({ ...(en.target || {}), id: curEx })
    }
    return modeOf({ id: curEx })
  })() : 'reps'
  const curCardio = curMode === 'cardio'
  const curTimed = curMode === 'time'
  const metric = s => curCardio ? (s.speed || 0) : curTimed ? (s.sec || 0) : (s.w || 0)
  const exUnit = curCardio ? 'km/h' : curTimed ? 's' : S.unit
  let exPts = [], exList = [], exBest = 0
  if (curEx) {
    workouts.forEach(w => {
      const en = (w.entries || []).find(e => e.id === curEx)
      if (en) {
        const doneSets = (en.sets || []).filter(s => s.done)
        const mx = Math.max(0, ...doneSets.map(metric), curCardio || curTimed ? 0 : (en.topW || 0))
        if (mx > 0) {
          exPts.push({ t: w.start, y: mx, d: w.d, sets: doneSets, target: en.target })
          if (mx > exBest) exBest = mx
        }
      }
    })
    exList = exPts.slice(-5).reverse()
  }
  const e1Pts = curEx ? e1rmSeries(S, curEx) : []
  const e1Best = curEx ? best1RM(S, curEx) : null
  const showE1 = e1Pts.length > 0
  const exRir = exPts.map(p => avgRir(p.sets))
  const showEff = exRir.filter(v => v != null).length >= 3
  const effPts = exPts.map((p, i) => (exRir[i] == null ? null : { t: p.t, y: toScale(kind, exRir[i]), d: p.d })).filter(Boolean)
  const onE1 = showE1 && exMetric === 'e1rm'
  const onEff = showEff && exMetric === 'effort'
  const topPts = exPts.map((p, i) => ({
    t: p.t, y: p.y, d: p.d,
    m: exRir[i] == null ? null : 1 - Math.min(4, Math.max(0, exRir[i])) / 4,
    note: exRir[i] == null ? undefined : hd + ' ' + fmtNum(toScale(kind, exRir[i]))
  }))
  const exOpts = [{ value: 'top', label: t('Top set') }]
  if (showE1) exOpts.push({ value: 'e1rm', label: t('Est. 1RM') })
  if (showEff) exOpts.push({ value: 'effort', label: t('Effort') })

  return (
    <div data-testid="stats-strength-tab">
      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t('Tonnage')}</h2>
          <span className="pillar-badge pillar-strength">{fmtVol(totalTonnage, S.unit)}</span>
        </div>
        {tonnagePts.length > 0 ? (
          <div className="chart"><LineChart points={tonnagePts} h={150} unit={S.unit} color="var(--pillar-strength)" /></div>
        ) : (
          <div className="muted small">{t('No workouts in this period yet.')}</div>
        )}
      </div>

      {workouts.length > 0 && <MuscleBalance S={S} />}
      {anyEffort && <EffortCard S={S} />}

      <div className="card">
        <h2>{t('Exercise progress')}</h2>
        {exHist.length ? <>
          <div className="sect-b" style={{ marginBottom: 10 }}>
            <SelectRow title={t('Exercise')} sheetTitle={t('Exercise progress')} value={curEx} onChange={setExId}
              options={exHist.map(id => ({ value: id, label: EXIDX[id].n }))} />
          </div>
          {exOpts.length > 1 && <Segmented className="seg-range" value={onEff ? 'effort' : onE1 ? 'e1rm' : 'top'} onChange={setExMetric} options={exOpts} />}
          <div className="chart">
            {onEff
              ? <LineChart points={effPts} h={150} unit={hd} color="var(--yellow)" invert={kind === 'rir'} />
              : <LineChart points={onE1 ? e1Pts.map(p => ({ t: p.t, y: p.y, d: p.d })) : topPts} h={150} unit={exUnit} color="var(--blue)" />}
          </div>
          <div style={{ marginTop: 8 }}>{exList.map((p, i) => <div key={i} className="row between small" style={{ padding: '6px 0', borderBottom: 'var(--hair) solid var(--sep)' }}>
            <span className="muted">{fmtDate(p.d, true)}</span><span>{p.sets.map(s => setLabel(curEx, s, p.target)).join('  ')}</span></div>)}</div>
          <div className="small dim" style={{ marginTop: 8 }}>
            {onEff ? t('Average effort per workout') : onE1 ? t('Estimated 1RM per workout') : curCardio ? t('Top speed per workout') : curTimed ? t('Longest hold per workout') : t('Best set weight per workout')}
            {onEff ? '' : <> · {t('Best:')}{' '}<b className="accent">{fmtNum(onE1 ? e1Best.est : exBest)} {onE1 ? S.unit : exUnit}</b></>}
          </div>
          {onE1 && <div className="small dim" style={{ marginTop: 4 }}>
            {t('Best estimate from {0} on {1} — an estimate, not a tested max.', fmtNum(e1Best.w) + ' ' + S.unit + ' × ' + e1Best.r, fmtDate(e1Best.d, true))}
          </div>}
          {!onEff && !onE1 && showEff && <div className="small dim" style={{ marginTop: 4 }}>
            {t('A fuller dot means less left in the tank — the same weight at a lower {0} is progress the line alone does not show.', hd)}
          </div>}
        </> : <div className="muted small">{t('Finish your first workout to see progress curves here.')}</div>}
      </div>

      {workouts.length > 0 && <>
        <div className="row between" style={{ marginBottom: 10 }}>
          <h4 className="sec" style={{ margin: 0 }}>{t('Recent workouts')}</h4>
          <Button size="sm" variant="ghost" trailingIcon="chevronRight" onClick={() => nav('/history')}>{t('All')} {workouts.length}</Button>
        </div>
        <div className="list">{[...workouts].reverse().slice(0, 6).map(w => <WorkoutRow key={w.id} w={w} onClick={() => workoutDetailSheet(w)} />)}</div>
      </>}
    </div>
  )
}

export default function Stats({ initialTab = 'overview' }) {
  let nav = () => {}
  try {
    nav = useNavigate()
  } catch {}
  const S = useStore(s => s.S) || {}
  const [tab, setTab] = useState(initialTab)
  const [range, setRange] = useState(30)
  const normUnit = S.unit === 'lb' ? 'lbs' : (S.unit || 'kg')
  const now = Date.now()

  const allHistory = unifiedHistory(S, 'all')
  const thisMonthPrefix = todayISO().slice(0, 7)
  const monthSessions = allHistory.filter(item => (item.d || '').startsWith(thisMonthPrefix)).length

  const bw = Array.isArray(S.bodyweight) ? S.bodyweight : []
  const bwPts = bw.filter(b => range === 0 || (b.t || new Date(b.d).getTime()) > now - range * 86400000)
    .map(b => ({ t: b.t || new Date(b.d).getTime(), y: b.w, d: b.d }))
  const bw30 = bw.filter(b => (b.t || new Date(b.d).getTime()) > now - 30 * 86400000)
  const bwDelta30 = bw30.length > 1 ? bw30[bw30.length - 1].w - bw30[0].w : null

  return <>
    <div className="hdr"><div><h1>{t('Stats')}</h1><div className="sub">{t('Progress & history')}</div></div>
      <button className="iconbtn" onClick={() => nav('/history')} aria-label={t('History')}><Icon name="history" /></button></div>

    <div style={{ marginBottom: 14 }}>
      <Segmented
        options={[
          { value: 'overview', label: t('Overview') },
          { value: 'cardio', label: t('Cardio') },
          { value: 'strength', label: t('Strength') },
        ]}
        value={tab}
        onChange={setTab}
      />
    </div>

    {tab === 'overview' && (
      <div data-testid="stats-overview-tab">
        <div className="tiles">
          <div className="tile"><div className="l"><Icon name="trophy" />{t('Sessions')}</div><div className="v">{allHistory.length}</div></div>
          <div className="tile"><div className="l"><Icon name="calendar" />{t('This month')}</div><div className="v">{monthSessions}</div></div>
          <div className="tile"><div className="l"><Icon name="flame" />{t('Week streak')}</div><div className="v">{streakWeeks(S)}</div></div>
          <div className="tile"><div className="l"><Icon name="scale" />{t('Weight 30d')}</div><div className="v" style={{ fontSize: 22, color: bwDelta30 === null ? 'inherit' : bwDeltaColor(bwDelta30, (lastBW(S) || {}).w || 0) }}>{bwDelta30 === null ? '—' : (bwDelta30 > 0 ? '+' : '') + fmtNum(bwDelta30) + ' ' + S.unit}</div></div>
        </div>

        <TrainingRhythmCard S={S} />

        <div className="card">
          <div className="row between" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{t('Activity — last 12 months')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {t('by time trained')}</span></h2>
            <Button size="sm" variant="ghost" icon="calendar" onClick={() => calendarSheet()}>{t('Calendar')}</Button>
          </div>
          <Heatmap S={S} onDay={iso => {
            const items = allHistory.filter(x => x.d === iso)
            if (items.length === 1 && items[0].entryType === 'cardio') nav('/cardio/' + items[0].id)
            else if (items.length === 1) workoutDetailSheet(items[0])
            else if (items.length) calendarSheet(iso)
          }} />
        </div>

        <div className="card">
          <div className="row between" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{t('Body weight')}</h2>
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" icon="target" style={S.targetW ? { color: 'var(--yellow)' } : undefined} onClick={goalSheet}>{S.targetW ? fmtNum(S.targetW) : t('Goal')}</Button>
              <Button size="sm" icon="plus" onClick={() => bwSheet()}>{t('Log')}</Button>
            </div>
          </div>
          <Segmented className="seg-range" value={range} onChange={setRange}
            options={[{ value: 30, label: '1M' }, { value: 90, label: '3M' }, { value: 365, label: '1Y' }, { value: 0, label: t('All') }]} />
          <div className="chart"><LineChart points={bwPts} h={160} unit={S.unit} goal={S.targetW} /></div>
        </div>
      </div>
    )}

    {tab === 'cardio' && <CardioStatsTab S={S} normUnit={normUnit} />}
    {tab === 'strength' && <StrengthStatsTab S={S} nav={nav} />}
  </>
}
