import { useState, useEffect, useRef } from 'react'
import { useStore, deleteRoute } from '../store/useStore.js'
import {
  EXDB,
  BODYPARTS,
  MODALITIES,
  allExercises,
  equipmentOf,
  exerciseModality,
  exercisePillarClass
} from '../lib/exercises.js'
import { bestWeightFor } from '../lib/history.js'
import { fmtNum } from '../lib/format.js'
import { fmtDist, formatElevation } from '../lib/cardio-format.js'
import { lazyFetchRoute } from '../lib/track-sync.js'
import { nav } from '../lib/nav.js'
import { t } from '../lib/i18n.js'
import { Thumb } from '../components/Media.jsx'
import RouteCanvas from '../components/RouteCanvas.jsx'
import GearManager from '../components/GearManager.jsx'
import { openGpxImportDialog } from '../components/GpxImportDialog.jsx'
import { exerciseDetailSheet, addToRoutineSheet, customExSheet, confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'

export function dedupeRoutes(S) {
  const seen = new Set()
  const out = []
  const raw = [
    ...(Array.isArray(S?.routes) ? S.routes : []),
    ...(Array.isArray(S?.savedRoutes) ? S.savedRoutes : [])
  ]
  for (const r of raw) {
    if (r && r.id && !seen.has(r.id)) {
      seen.add(r.id)
      out.push(r)
    }
  }
  return out
}

const MODALITY_LABELS = {
  strength: 'Strength',
  yoga: 'Yoga',
  mobility: 'Mobility',
  cardio: 'HIIT / Cardio'
}

export function RouteCard({ route, unit }) {
  const [points, setPoints] = useState(() => Array.isArray(route?.points) ? route.points : [])

  useEffect(() => {
    let active = true
    if (Array.isArray(route?.points) && route.points.length > 0) {
      setPoints(route.points)
      return () => { active = false }
    }
    lazyFetchRoute(route).then(data => {
      if (!active || !data) return
      const pts = Array.isArray(data.points) ? data.points : (Array.isArray(data) ? data : [])
      if (pts.length > 0) setPoints(pts)
    }).catch(() => {})
    return () => { active = false }
  }, [route])

  const distLabel = fmtDist(route?.distanceM || 0, unit)
  const elevLabel = formatElevation(route?.elevationGainM || 0, unit)

  const handleFollow = () => {
    nav('/record?route=' + encodeURIComponent(route.id), {
      state: { followRouteId: route.id, followRoute: route }
    })
  }

  const handleDelete = () => {
    confirmSheet({
      title: t('Delete route?'),
      message: t('This removes the saved route for good.'),
      confirmText: t('Delete'),
      danger: true,
      onConfirm: () => deleteRoute(route.id)
    })
  }

  return (
    <div className="item" style={{ alignItems: 'center', gap: 12 }}>
      <div
        style={{
          width: 72,
          height: 54,
          borderRadius: 8,
          background: 'var(--surface-2, #1e1e1e)',
          overflow: 'hidden',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <RouteCanvas
          points={points}
          width={72}
          height={54}
          padding={6}
          lineWidth={2}
          dotRadius={3}
        />
      </div>
      <div className="grow">
        <div className="tt">{route.name || t('Unnamed Route')}</div>
        <div className="ss">
          {distLabel}{elevLabel ? ` · +${elevLabel}` : ''}
        </div>
      </div>
      <Button size="sm" variant="primary" onClick={handleFollow}>
        {t('Follow Route')}
      </Button>
      <button
        type="button"
        className="iconbtn"
        aria-label={t('Delete')}
        onClick={handleDelete}
      >
        <Icon name="trash" />
      </button>
    </div>
  )
}

export default function Library({ initialSection = 'exercises' }) {
  const storeS = useStore?.getState?.()?.S
  const hookS = typeof useStore === 'function' ? useStore(s => s.S) : null
  const S = hookS || storeS || {}
  const normUnit = S.unit === 'lb' ? 'lbs' : (S.unit || 'kg')

  const [section, setSection] = useState(initialSection)
  const [modality, setModality] = useState('')
  const [q, setQ] = useState('')
  const [bp, setBp] = useState('')
  const [eq, setEq] = useState('')
  const [shown, setShown] = useState(40)
  const fileInputRef = useRef(null)

  const allEx = allExercises(S)
  const modalityScoped = modality ? allEx.filter(e => exerciseModality(e) === modality) : allEx
  const bpOpts = modality
    ? BODYPARTS.filter(b => modalityScoped.some(e => e.bp === b))
    : BODYPARTS
  const bpOn = bpOpts.includes(bp) ? bp : ''

  const ql = q.toLowerCase().trim()
  const base = modalityScoped.filter(
    e =>
      (!bpOn || e.bp === bpOn) &&
      (!ql ||
        e.n.toLowerCase().includes(ql) ||
        (e.tg || '').includes(ql) ||
        (e.eq || '').includes(ql) ||
        (e.desc || '').toLowerCase().includes(ql))
  )
  const eqOpts = equipmentOf(base)
  // Drop the equipment filter if the search narrowed it away, so you never hit a dead end.
  const eqOn = eqOpts.includes(eq) ? eq : ''
  const f = eqOn ? base.filter(e => e.eq === eqOn) : base

  const routes = dedupeRoutes(S)

  const handleFileChange = e => {
    const file = e.target?.files?.[0]
    if (file) {
      openGpxImportDialog({ file, defaultDestination: 'route' })
    }
    if (e.target) e.target.value = ''
  }

  return (
    <>
      <div className="hdr">
        <div>
          <h1>{t('Library')}</h1>
          <div className="sub">
            {section === 'exercises' && t('{0} exercises with animations', EXDB.length)}
            {section === 'routes' && t('Saved GPS & GPX routes')}
            {section === 'gear' && t('Shoe & bike mileage tracker')}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <Segmented
          options={[
            { value: 'exercises', label: t('Exercises') },
            { value: 'routes', label: t('Routes') },
            { value: 'gear', label: t('Gear') }
          ]}
          value={section}
          onChange={setSection}
        />
      </div>

      {section === 'exercises' && (
        <>
          <div className="search" style={{ marginBottom: 10 }}>
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              className="input"
              placeholder={t('Search…')}
              value={q}
              onChange={e => { setQ(e.target.value); setShown(40) }}
            />
          </div>

          <div className="chips" style={{ marginBottom: 8 }}>
            <button
              className={'chip nocap' + (!modality ? ' on' : '')}
              onClick={() => { setModality(''); setBp(''); setEq(''); setShown(40) }}
            >
              {t('All')}
            </button>
            {MODALITIES.map(m => (
              <button
                key={m.id}
                className={'chip' + (modality === m.id ? ' on' : '')}
                onClick={() => { setModality(m.id); setBp(''); setEq(''); setShown(40) }}
              >
                {t(m.label)}
              </button>
            ))}
          </div>

          <div className="chips" style={{ marginBottom: eqOpts.length > 1 ? 8 : 12 }}>
            <button
              className={'chip nocap' + (!bpOn ? ' on' : '')}
              onClick={() => { setBp(''); setEq(''); setShown(40) }}
            >
              {t('All')}
            </button>
            {bpOpts.map(b => (
              <button
                key={b}
                className={'chip' + (bpOn === b ? ' on' : '')}
                onClick={() => { setBp(b); setEq(''); setShown(40) }}
              >
                {t(b)}
              </button>
            ))}
          </div>

          {eqOpts.length > 1 && (
            <div className="chips" style={{ marginBottom: 12 }}>
              <button
                className={'chip nocap' + (!eqOn ? ' on' : '')}
                onClick={() => { setEq(''); setShown(40) }}
              >
                {t('Any equipment')}
              </button>
              {eqOpts.map(x => (
                <button
                  key={x}
                  className={'chip' + (eqOn === x ? ' on' : '')}
                  onClick={() => { setEq(x); setShown(40) }}
                >
                  {t(x)}
                </button>
              ))}
            </div>
          )}

          <div className="list">
            <div className="item" onClick={() => customExSheet(null, ex => exerciseDetailSheet(ex), q.trim())}>
              <div className="thumb thumb-x"><Icon name="sparkles" /></div>
              <div className="grow">
                <div className="tt">{t('Create your own exercise')}</div>
                <div className="ss">{t('name + body part, no animation')}</div>
              </div>
              <Icon name="plus" className="chev" />
            </div>
            {f.slice(0, shown).map(e => {
              const best = bestWeightFor(S, e.id)
              const mod = exerciseModality(e)
              const pillarCls = exercisePillarClass(e)
              return (
                <div key={e.id} className="item" onClick={() => exerciseDetailSheet(e)}>
                  <Thumb ex={e} />
                  <div className="grow">
                    <div className="tt capitalize">{e.n}</div>
                    <div className="ss capitalize">{t(e.tg || e.bp)} · {t(e.eq)}</div>
                  </div>
                  <span className={`pillar-badge ${pillarCls}`}>
                    {t(MODALITY_LABELS[mod] || 'Strength')}
                  </span>
                  {best > 0 && <span className="tag acc">{fmtNum(best)}</span>}
                  <Button
                    size="sm"
                    variant="tinted"
                    icon="plus"
                    onClick={ev => { ev.stopPropagation(); addToRoutineSheet(e) }}
                  >
                    {t('Plan')}
                  </Button>
                </div>
              )
            })}
            {f.length === 0 && (
              <div className="empty">
                <div className="ico"><Icon name="magnifier" /></div>
                {t('No match')}
              </div>
            )}
          </div>
          {f.length > shown && (
            <>
              <div style={{ height: 10 }} />
              <Button onClick={() => setShown(s => s + 40)}>{t('Show more')}</Button>
            </>
          )}
        </>
      )}

      {section === 'routes' && (
        <div className="routes-section">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gpx,application/gpx+xml,text/xml"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <Button
              variant="primary"
              size="sm"
              icon="plus"
              onClick={() => fileInputRef.current?.click()}
            >
              {t('Import GPX')}
            </Button>
          </div>

          {routes.length === 0 ? (
            <div className="empty">
              <div className="ico"><Icon name="globe" /></div>
              {t('No saved routes yet. Import a GPX file to get started.')}
            </div>
          ) : (
            <div className="list">
              {routes.map(r => (
                <RouteCard key={r.id} route={r} unit={normUnit} />
              ))}
            </div>
          )}
        </div>
      )}

      {section === 'gear' && (
        <GearManager inline unit={normUnit} />
      )}
    </>
  )
}
