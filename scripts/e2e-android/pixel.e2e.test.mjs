import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import {
  adb,
  appFileExists,
  backgroundApp,
  clearApp,
  clearLogcat,
  connectWebView,
  deviceScreenshot,
  forceStop,
  foregroundApp,
  getCrashLogcat,
  getNotificationDump,
  getServiceDump,
  grantPermissions,
  launchApp,
  pushMockGpsFix,
  revokeLocationPermissions,
  startMockGps,
  stopMockGps,
  wakeScreen,
} from './cdp.mjs'

const PKG = 'ch.duartesantos.opengym'
const SVC = '.BackgroundLocationService'
const AUDIT_DIR = '/tmp/opengym-e2e/ux-audit'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const uxAudits = []

async function captureUX(wv, slug) {
  await sleep(300)
  const metrics = await wv.auditUX(slug)
  uxAudits.push(metrics)
  await deviceScreenshot(`${AUDIT_DIR}/${slug}-device.png`).catch(() => {})
  return metrics
}

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastVal
  while (Date.now() < deadline) {
    lastVal = await fn()
    if (lastVal) return lastVal
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`)
}

async function runSession(name, fn) {
  const ctx = { wv: null }
  try {
    ctx.wv = await connectWebView(PKG)
    await fn(ctx)
  } catch (err) {
    await ctx.wv?.screenshot(`/tmp/opengym-e2e/${name}.png`).catch(() => {})
    await deviceScreenshot(`/tmp/opengym-e2e/${name}-device.png`).catch(() => {})
    throw err
  } finally {
    await ctx.wv?.close().catch(() => {})
  }
}

async function clickTab(wv, label) {
  const ok = await wv.waitFor(`(() => {
    const btn = [...document.querySelectorAll('#tabbar button')].find(b => b.textContent.includes(${JSON.stringify(label)}));
    if (!btn) return false;
    btn.click();
    return true;
  })()`, { label: `tab ${label}` })
  assert.ok(ok)
}

function hasActiveNotif(dump) {
  return /NotificationRecord\([^)]*pkg=ch\.duartesantos\.opengym[^)]*\bid=4201\b/.test(dump)
}

async function waitForSystemBarLight(wv, expected) {
  return wv.waitFor(
    `(async () => {
      const s = await window.Capacitor?.Plugins?.SystemBars?.getStyle?.();
      if (!s) return false;
      return s.isAppearanceLightStatusBars === ${Boolean(expected)} && s.isAppearanceLightNavigationBars === ${Boolean(expected)} ? s : false;
    })()`,
    { label: `system bars light=${expected}` }
  )
}

function parseDistanceKm(text) {
  const m = String(text || '').match(/(\d+(?:[.,]\d+)?)\s*(km|mi|m)\b/i)
  if (!m) throw new Error(`Could not parse distance from: ${JSON.stringify(text)}`)
  const val = parseFloat(m[1].replace(',', '.'))
  const unit = m[2].toLowerCase()
  if (unit === 'km') return val
  if (unit === 'mi') return val * 1.60934
  return val / 1000
}

async function assertCompactActivityTopbar(wv, label) {
  const m = await wv.evalJs(`(() => {
    const back = document.querySelector('[data-testid="back-btn"].iconbtn');
    const edit = document.querySelector('[data-testid="edit-activity-btn"].sm');
    const exp = document.querySelector('[data-testid="gpx-export-btn"].sm');
    const bar = back?.closest('.activity-detail-topbar');
    if (!bar || !back || !edit || !exp) return null;
    const r = el => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
    };
    return {
      bar: r(bar),
      back: r(back),
      edit: r(edit),
      exp: r(exp),
      overflow: bar.scrollWidth > bar.clientWidth + 1 || bar.getBoundingClientRect().right > window.innerWidth + 1,
    };
  })()`)
  assert.ok(m, `${label}: compact activity topbar elements missing`)
  assert.ok(m.bar.height > 0 && m.bar.height <= 48, `${label}: topbar height ${m.bar.height} must be <= 48`)
  assert.ok(
    Math.abs(m.back.top - m.edit.top) <= 6 && Math.abs(m.edit.top - m.exp.top) <= 6,
    `${label}: topbar buttons must align on one row: ${JSON.stringify(m)}`
  )
  assert.ok(m.back.right <= m.edit.left + 1 && m.edit.right <= m.exp.left + 1, `${label}: topbar buttons must not wrap or overlap`)
  assert.equal(m.overflow, false, `${label}: topbar must have zero horizontal overflow`)
}

test('T1: fresh install boot, Login & Cold-Start UX audit, Capacitor bridge, onboarding hybrid starter plan', async () => {
  await mkdir(AUDIT_DIR, { recursive: true })
  await clearLogcat()
  await clearApp(PKG)
  await grantPermissions(PKG)
  await wakeScreen()
  await launchApp(PKG)

  await runSession('t1', async ({ wv }) => {
    const landed = await wv.waitFor(`(() => {
      if (document.querySelector('[data-testid="home-onboarding-chooser"]')) return 'onboarding';
      const guestBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Continue without account'));
      return guestBtn ? 'login' : false;
    })()`, { timeoutMs: 20000, label: 'login or onboarding' })

    if (landed === 'login') {
      await captureUX(wv, '01-login')
      await wv.clickButtonByText('Continue without account')
    }
    await wv.waitForSelector('[data-testid="home-onboarding-chooser"]')
    await wv.waitForSelector('[data-testid="home-today-card"]')
    const onboardOrder = await wv.evalJs(`(() => {
      const chooser = document.querySelector('[data-testid="home-onboarding-chooser"]')?.getBoundingClientRect();
      const today = document.querySelector('[data-testid="home-today-card"]')?.getBoundingClientRect();
      return chooser && today ? {
        chooserTop: Math.round(chooser.top),
        chooserBottom: Math.round(chooser.bottom),
        todayTop: Math.round(today.top),
      } : null;
    })()`)
    assert.ok(onboardOrder, 'Must measure onboarding chooser and today card pre-onboarding')
    assert.ok(
      onboardOrder.chooserTop < onboardOrder.todayTop && onboardOrder.chooserBottom <= onboardOrder.todayTop,
      `Onboarding chooser must appear above Today card, got ${JSON.stringify(onboardOrder)}`
    )
    const preOnboardUX = await captureUX(wv, '02-home-pre-onboarding')

    const bridge = await wv.evalJs('({ native: window.Capacitor?.isNativePlatform?.(), bg: window.Capacitor?.isPluginAvailable?.("BackgroundLocation"), bars: window.Capacitor?.isPluginAvailable?.("SystemBars") })')
    assert.equal(bridge.native, true, 'Capacitor.isNativePlatform() must be true')
    assert.equal(bridge.bg, true, 'BackgroundLocation plugin must be available')
    assert.equal(bridge.bars, true, 'SystemBars plugin must be available')
    assert.equal(wv.errors.length, 0, `Unexpected JS errors: ${wv.errors.join('; ')}`)
    assert.ok(preOnboardUX.viewport.width > 0, 'UX probe must capture viewport metrics')

    const crash = await getCrashLogcat()
    assert.ok(!crash.includes('FATAL EXCEPTION'), `Fatal crash in logcat:\n${crash}`)

    await wv.clickSelector('[data-testid="starter-option-hybrid"]')
    await wv.waitForSelector('[data-testid="home-today-card"]')
    await wv.waitForSelector('[data-testid="home-week-glance"]')
    await wv.waitFor('document.querySelector(\'[data-testid="home-onboarding-chooser"]\') === null', {
      label: 'onboarding card dismissed',
    })
    await captureUX(wv, '03-home-post-onboarding')
  })
})

test('T2: tab traversal, RoutineEdit ergonomics audit, Library, Stats/History, Privacy & persistent Light theme', async () => {
  await runSession('t2', async ctx => {
    let { wv } = ctx
    await wv.waitForSelector('[data-testid="home-today-card"]')

    await clickTab(wv, 'Plan')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Plan")', { label: 'Plan heading' })
    await captureUX(wv, '04-plan')

    // Open first routine in RoutineEdit (/plan/r/:id) to audit touch targets
    const openedRoutine = await wv.evalJs(`(() => {
      const items = [...document.querySelectorAll('.cols > div:nth-child(2) .list .item')];
      if (!items.length) return false;
      items[0].click();
      return true;
    })()`)
    assert.equal(openedRoutine, true, 'Must open first routine in RoutineEdit')
    await wv.waitFor('window.location.hash.startsWith("#/plan/r/")', { label: 'RoutineEdit route' })
    await captureUX(wv, '05-routine-edit')
    await wv.clickSelector('button[aria-label="Plan"]')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Plan")', { label: 'Back to Plan' })

    await clickTab(wv, 'Library')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Library")', { label: 'Library heading' })
    await wv.waitFor('document.body.innerText.includes("exercises with animations")', { label: 'Exercises subtab' })
    await captureUX(wv, '06-library-exercises')
    await wv.clickButtonByText('Routes')
    await wv.waitFor('document.body.innerText.includes("Saved GPS & GPX routes")', { label: 'Routes subtab' })
    await wv.clickButtonByText('Gear')
    await wv.waitFor('document.body.innerText.includes("Shoe & bike mileage tracker")', { label: 'Gear subtab' })

    await clickTab(wv, 'Stats')
    await wv.waitForSelector('[data-testid="stats-overview-tab"]')
    await captureUX(wv, '07-stats-overview')
    await wv.clickButtonByText('Cardio')
    await wv.waitForSelector('[data-testid="stats-cardio-tab"]')
    await wv.clickButtonByText('Strength')
    await wv.waitForSelector('[data-testid="stats-strength-tab"]')

    await wv.clickSelector('button[aria-label="History"]')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("History")', { label: 'History heading' })
    await captureUX(wv, '08-history')

    await clickTab(wv, 'Home')
    await wv.waitForSelector('[data-testid="home-today-card"]')

    await wv.clickSelector('button[aria-label="Settings"]')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Settings")', { label: 'Settings heading' })
    await waitForSystemBarLight(wv, false)
    await captureUX(wv, '09-settings-dark')

    await wv.clickButtonByText('Privacy, Maps & Track Retention')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Privacy")', { label: 'Privacy heading' })
    await wv.waitFor('document.body.innerText.includes("External features") && document.body.innerText.includes("GPS Track Retention") && Boolean(document.querySelector(\'button[role="switch"]\'))', { label: 'privacy controls' })
    const privacyIconsOk = await wv.evalJs(`(() => {
      const icons = [...document.querySelectorAll('.lrow-i')];
      return icons.length > 0 && icons.every(el => Boolean(el.querySelector('svg')));
    })()`)
    assert.equal(privacyIconsOk, true, 'All PrivacySettings .lrow-i icons must render an <svg>')
    await captureUX(wv, '10-privacy-settings')

    await wv.clickButtonByText('OpenStreetMap Map Tiles')
    await wv.waitForSelector('.consent-sheet')
    const consentCheck = await wv.evalJs(`(() => ({
      hasCard: Boolean(document.querySelector('.consent-sheet .card')),
      hasIconSvg: Boolean(document.querySelector('.consent-sheet .lrow-i svg')),
      hasSectB: Boolean(document.querySelector('.consent-sheet .sect-b')),
    }))()`)
    assert.equal(consentCheck.hasCard, true, 'ConsentSheet must render .consent-sheet .card')
    assert.equal(consentCheck.hasIconSvg, true, 'ConsentSheet must render .consent-sheet .lrow-i svg')
    assert.equal(consentCheck.hasSectB, false, 'ConsentSheet must not render .consent-sheet .sect-b')
    await wv.clickButtonByText('Not now')
    await wv.waitFor('document.querySelector(".consent-sheet") === null', { label: 'ConsentSheet closed' })

    await wv.clickSelector('button[aria-label="Back"]')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Settings")', { label: 'Settings back' })

    await wv.clickButtonByText('Light')
    await wv.waitFor('document.documentElement.dataset.theme === "light"', { label: 'light theme applied' })
    await waitForSystemBarLight(wv, true)

    await wv.close()
    ctx.wv = null
    await forceStop(PKG)
    await launchApp(PKG)
    ctx.wv = wv = await connectWebView(PKG)

    await wv.waitForSelector('[data-testid="home-today-card"]')
    assert.equal(await wv.evalJs('document.documentElement.dataset.theme'), 'light')
    assert.equal(await wv.evalJs('document.querySelector(\'[data-testid="home-onboarding-chooser"]\') === null'), true)
    await waitForSystemBarLight(wv, true)
    await captureUX(wv, '11-home-light-persisted')

    // Restore Dark theme for gym-floor baseline screenshots
    await wv.clickSelector('button[aria-label="Settings"]')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Settings")', { label: 'Settings heading' })
    await wv.clickButtonByText('Dark')
    await wv.waitFor('document.documentElement.dataset.theme === "dark"', { label: 'dark theme restored' })
    await waitForSystemBarLight(wv, false)
    await clickTab(wv, 'Home')
    await wv.waitForSelector('[data-testid="home-today-card"]')
  })
})

test('T3: strength workout via Start Hub, mark set done, rest timer audit, finish & verify history', async () => {
  await runSession('t3', async ({ wv }) => {
    await wv.waitForSelector('[data-testid="home-today-card"]')
    await wv.clickSelector('#tabbar button.start')
    await wv.waitForSelector('[data-testid="start-hub-sheet"]')
    await captureUX(wv, '12-start-hub-sheet')

    await wv.clickSelector('[data-testid="quick-action-strength"]')
    await wv.waitForSelector('[data-testid="start-hub-strength"]')

    const hasRoutine = await wv.evalJs('Boolean(document.querySelector(\'[data-testid="start-hub-strength"] .list button.item\'))')
    if (hasRoutine) {
      await wv.clickSelector('[data-testid="start-hub-strength"] .list button.item')
    } else {
      await wv.clickButtonByText('Freestyle workout')
    }

    await wv.waitForSelector('button[aria-label="Finish"]')
    await wv.waitForSelector('.setrow button.chk')
    await wv.clickSelector('.setrow button.chk')
    await wv.waitForSelector('.setrow.done')
    await wv.waitForSelector('#timer.rest')
    await captureUX(wv, '13-workout-active-resting')

    const restClearance = await wv.evalJs(`(async () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const finishBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Finish workout early'));
      const timerEl = document.querySelector('#timer.rest');
      const tabbarEl = document.querySelector('#tabbar');
      if (!finishBtn || !timerEl || !tabbarEl) return null;
      const f = finishBtn.getBoundingClientRect();
      const tm = timerEl.getBoundingClientRect();
      const tb = tabbarEl.getBoundingClientRect();
      return {
        finish: { top: Math.round(f.top), bottom: Math.round(f.bottom) },
        timer: { top: Math.round(tm.top), bottom: Math.round(tm.bottom) },
        tabbar: { top: Math.round(tb.top), bottom: Math.round(tb.bottom) },
      };
    })()`)
    assert.ok(restClearance, 'Must measure Finish workout early button, #timer.rest, and #tabbar')
    assert.ok(
      restClearance.finish.top >= 0 &&
        restClearance.finish.bottom <= restClearance.timer.top &&
        restClearance.finish.bottom <= restClearance.tabbar.top,
      `Finish workout early button must clear #timer.rest and #tabbar, got ${JSON.stringify(restClearance)}`
    )

    await wv.clickSelector('button[aria-label="Finish"]')

    const step = await wv.waitFor(`(() => {
      const t = document.body.innerText;
      if (t.includes('Finish early?')) return 'early';
      if (t.includes('Workout complete!')) return 'complete';
      return false;
    })()`, { label: 'finish prompt or summary' })
    if (step === 'early') {
      await captureUX(wv, '14-workout-finish-early-sheet')
      await wv.clickButtonByText('Finish workout')
    }

    await wv.waitFor('document.body.innerText.includes("Workout complete!")', { label: 'Workout complete summary' })
    await captureUX(wv, '15-workout-complete-sheet')
    await wv.clickButtonByText('Nice!')

    await wv.waitForSelector('[data-testid="home-today-card"]')
    await wv.waitForSelector('[data-testid="unified-recent-activity"] .item')
  })
})

test('T4: Guided Flow (/flow/:id) progression, mid-session TabBar Resume pill & sRPE completion', async () => {
  await runSession('t4', async ({ wv }) => {
    await wv.waitForSelector('[data-testid="home-today-card"]')
    await wv.clickSelector('#tabbar button.start')
    await wv.waitForSelector('[data-testid="start-hub-sheet"]')
    await wv.clickSelector('[data-testid="quick-action-flow"]')
    await wv.waitForSelector('[data-testid="start-hub-flow"]')
    await wv.clickSelector('[data-testid="start-hub-flow"] .list button.item')

    await wv.waitForSelector('.flow-player-view')
    await captureUX(wv, '16-flow-player-live')

    // Pause and resume controls
    await wv.clickSelector('button[aria-label="Pause"]')
    await wv.waitForSelector('button[aria-label="Resume"]')
    await wv.clickSelector('button[aria-label="Resume"]')
    await wv.waitForSelector('button[aria-label="Pause"]')

    // Navigate to Home mid-session and verify TabBar shows orange Resume pill
    await wv.evalJs('window.location.hash = "#/home"')
    await wv.waitForSelector('[data-testid="home-today-card"]')
    await wv.waitForSelector('#tabbar button.start.rec')
    const resumeLabel = await wv.evalJs('document.querySelector("#tabbar button.start.rec")?.textContent || ""')
    assert.ok(resumeLabel.includes('Resume'), `Expected TabBar Resume pill, got: ${resumeLabel}`)
    await captureUX(wv, '17-home-flow-resume-pill')

    // Tap TabBar Resume button to return to FlowPlayer
    await wv.clickSelector('#tabbar button.start.rec')
    await wv.waitForSelector('.flow-player-view')

    // Advance through remaining moves to completion
    await wv.waitFor(`(() => {
      if (document.body.innerText.includes('Flow complete!')) return true;
      const skip = document.querySelector('button[aria-label="Skip move"]');
      if (skip) skip.click();
      return document.body.innerText.includes('Flow complete!');
    })()`, { timeoutMs: 20000, intervalMs: 250, label: 'Flow complete screen' })

    await wv.waitForSelector('[data-testid="flow-rpe-chip-8"]')
    await wv.clickSelector('[data-testid="flow-rpe-chip-8"]')
    await captureUX(wv, '18-flow-complete-srpe')
    await wv.clickButtonByText('Done')

    await wv.waitForSelector('[data-testid="home-today-card"]')
    assert.equal(await wv.evalJs('document.querySelector("#tabbar button.start.rec") === null'), true)
  })
})

test('T5: Gear creation, Manual Cardio logging & /cardio/:id ActivityDetail Edit round-trip', async () => {
  await runSession('t5', async ({ wv }) => {
    await wv.waitForSelector('[data-testid="home-today-card"]')
    await clickTab(wv, 'Library')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Library")', { label: 'Library heading' })
    await wv.clickButtonByText('Gear')
    await wv.waitFor('document.body.innerText.includes("Shoe & bike mileage tracker")', { label: 'Gear subtab' })

    await wv.clickButtonByText('+ Add Gear')
    await wv.waitFor('Boolean(document.querySelector(\'input[placeholder*="Pegasus"]\'))', { label: 'Gear name input' })
    await wv.evalJs(`(() => {
      const inp = document.querySelector('input[placeholder*="Pegasus"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'Pixel 9a Runner');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await wv.clickButtonByText('Save Gear')
    await wv.waitFor('document.body.innerText.includes("Pixel 9a Runner")', { label: 'Gear card created' })
    await wv.clickButtonByText('Set default')
    await wv.waitFor('document.body.innerText.includes("Default")', { label: 'Gear marked default' })
    const gearBtnAudit = await wv.evalJs(`(() => {
      const card = document.querySelector('.gear-card');
      const cardW = card ? card.getBoundingClientRect().width : 0;
      const smBtns = [...document.querySelectorAll('.gear-manager button.btn.sm')];
      const legacySmall = document.querySelectorAll('.btn.small').length;
      return {
        smCount: smBtns.length,
        legacySmall,
        cardW: Math.round(cardW),
        allNarrower: cardW > 0 && smBtns.every(b => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().width < cardW),
      };
    })()`)
    assert.ok(gearBtnAudit.smCount >= 3, `Expected >= 3 .gear-manager button.btn.sm, got ${gearBtnAudit.smCount}`)
    assert.equal(gearBtnAudit.legacySmall, 0, 'Must have 0 .btn.small buttons')
    assert.equal(gearBtnAudit.allNarrower, true, `All .gear-manager button.btn.sm widths must be narrower than .gear-card (${gearBtnAudit.cardW})`)
    await captureUX(wv, '19-library-gear')

    // Log Manual Cardio via Start Hub
    await wv.clickSelector('#tabbar button.start')
    await wv.waitForSelector('[data-testid="start-hub-sheet"]')
    await wv.clickSelector('[data-testid="quick-action-manual-cardio"]')
    await wv.waitForSelector('.manual-cardio-sheet')
    await captureUX(wv, '20-manual-cardio-sheet')

    const manualSheetAudit = await wv.evalJs(`(() => {
      const mc = document.querySelector('.manual-cardio-sheet');
      const sheet = mc?.closest('.sheet') || document.querySelector('.sheet');
      const sel = mc?.querySelector('[data-testid="manual-gear-selector"]');
      const selectedGear = sel?.options?.[sel.selectedIndex]?.text || '';
      const sr = sheet?.getBoundingClientRect();
      const fields = mc ? [...mc.querySelectorAll('input, select, textarea')] : [];
      const outOfBounds = sr ? fields.filter(f => {
        const r = f.getBoundingClientRect();
        return r.width > 0 && (r.left < sr.left - 1 || r.right > sr.right + 1);
      }).map(f => ({ tag: f.tagName, left: Math.round(f.getBoundingClientRect().left), right: Math.round(f.getBoundingClientRect().right) })) : ['missing-sheet'];
      return {
        selectedGear,
        sheetOverflow: sheet ? sheet.scrollWidth > sheet.clientWidth + 1 : true,
        mcOverflow: mc ? mc.scrollWidth > mc.clientWidth + 1 : true,
        outOfBounds,
      };
    })()`)
    assert.ok(manualSheetAudit.selectedGear.includes('Pixel 9a Runner'), `manual-gear-selector must default to Pixel 9a Runner, got: ${manualSheetAudit.selectedGear}`)
    assert.equal(manualSheetAudit.sheetOverflow, false, 'ManualCardioSheet .sheet must have zero horizontal overflow')
    assert.equal(manualSheetAudit.mcOverflow, false, 'ManualCardioSheet must have zero horizontal overflow')
    assert.deepEqual(manualSheetAudit.outOfBounds, [], 'All inputs/select/textarea must fit inside .sheet bounds')

    await wv.evalJs(`(() => {
      const sheet = document.querySelector('.manual-cardio-sheet');
      const numInputs = [...sheet.querySelectorAll('input.num:not([type="datetime-local"])')];
      const setVal = (el, val) => {
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      // Duration (min), Sec, Distance (km), Elevation Gain (m)
      setVal(numInputs[0], '25');
      setVal(numInputs[2], '5');
      setVal(numInputs[3], '45');
      const notesEl = sheet.querySelector('textarea');
      if (!notesEl) throw new Error('ManualCardioSheet notes textarea not found');
      const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      taSetter.call(notesEl, 'Morning lake run');
      notesEl.dispatchEvent(new Event('input', { bubbles: true }));
      notesEl.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await wv.clickButtonByText('Save activity')
    await wv.waitFor('document.querySelector(".manual-cardio-sheet") === null', { label: 'ManualCardioSheet closed' })

    // Navigate to Home and open the newly logged cardio activity in ActivityDetail
    await clickTab(wv, 'Home')
    await wv.waitForSelector('[data-testid="unified-recent-activity"]')
    const cardioRowText = await wv.waitFor(`(() => {
      const items = [...document.querySelectorAll('[data-testid="unified-recent-activity"] .item')];
      const target = items.find(el => el.textContent.includes('5 km') && el.textContent.includes('25 min'));
      if (!target) return false;
      const txt = target.textContent;
      target.click();
      return txt;
    })()`, { label: 'open logged 5 km / 25 min run in Recent Activity' })
    assert.ok(cardioRowText, 'Must find and open logged manual cardio in Recent Activity')
    assert.ok(cardioRowText.includes('5:00 min/km'), `Recent Activity row must show 5:00 min/km, got: ${cardioRowText}`)
    assert.equal(cardioRowText.includes('300:00'), false, `Recent Activity row must not show 300:00, got: ${cardioRowText}`)

    await wv.waitForSelector('[data-testid="activity-detail-view"]')
    await assertCompactActivityTopbar(wv, 'T5 manual cardio')
    await captureUX(wv, '20b-activity-detail-manual')
    const kpiDist = await wv.evalJs('document.querySelector(\'[data-testid="kpi-distance"]\')?.textContent || ""')
    assert.ok(kpiDist.includes('5 km') || kpiDist.includes('5.0'), `Expected 5 km in KPI distance, got: ${kpiDist}`)
    const paceText = await wv.evalJs('document.querySelector(\'[data-testid="kpi-rate"]\')?.textContent || ""')
    assert.ok(paceText.includes('5:00 min/km'), `Expected 5:00 min/km in kpi-rate, got: ${paceText}`)
    assert.equal(paceText.includes('300:00'), false, `kpi-rate must not show 300:00, got: ${paceText}`)
    const dateText = await wv.evalJs('document.querySelector(\'[data-testid="activity-date"]\')?.textContent?.trim() || ""')
    assert.ok(dateText.length > 0 && !dateText.includes('Invalid Date'), `Expected valid activity-date, got: ${dateText}`)
    const notesCheck = await wv.evalJs(`(() => {
      const el = document.querySelector('[data-testid="activity-notes"]');
      return el ? { text: el.textContent, overflow: el.scrollWidth > el.clientWidth + 1 } : null;
    })()`)
    assert.ok(notesCheck && notesCheck.text.includes('Morning lake run'), `Expected Morning lake run in activity-notes, got: ${JSON.stringify(notesCheck)}`)
    assert.equal(notesCheck.overflow, false, 'activity-notes must have zero horizontal overflow')

    // Edit elevation gain (45 -> 60) and notes via Edit button
    await wv.clickSelector('[data-testid="edit-activity-btn"]')
    await wv.waitForSelector('.manual-cardio-sheet')
    const editPre = await wv.evalJs(`(() => {
      const sheet = document.querySelector('.manual-cardio-sheet');
      const sel = sheet?.querySelector('[data-testid="manual-gear-selector"]');
      const ta = sheet?.querySelector('textarea');
      return {
        selectedGear: sel?.options?.[sel.selectedIndex]?.text || '',
        notesVal: ta?.value || '',
      };
    })()`)
    assert.ok(editPre.selectedGear.includes('Pixel 9a Runner'), `Edit sheet must retain Pixel 9a Runner, got: ${editPre.selectedGear}`)
    assert.equal(editPre.notesVal, 'Morning lake run', 'Edit sheet must pre-populate notes')

    await wv.evalJs(`(() => {
      const sheet = document.querySelector('.manual-cardio-sheet');
      const numInputs = [...sheet.querySelectorAll('input.num:not([type="datetime-local"])')];
      const elev = numInputs[3];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(elev, '60');
      elev.dispatchEvent(new Event('input', { bubbles: true }));
      elev.dispatchEvent(new Event('change', { bubbles: true }));
      const ta = sheet.querySelector('textarea');
      const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      taSetter.call(ta, 'Updated: felt strong on hills');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await wv.clickButtonByText('Update activity')
    await wv.waitFor('document.querySelector(\'[data-testid="kpi-elevation"]\')?.textContent.includes("60")', { label: 'Updated elevation in ActivityDetail' })
    await wv.waitFor('document.querySelector(\'[data-testid="activity-notes"]\')?.textContent.includes("Updated: felt strong on hills")', { label: 'Updated notes in ActivityDetail' })
  })
})

test('T6: GPX Route import, Follow Route + off-route banner, GPS finish, Gear mileage & ActivityDetail Trim/Elevation/SaveRoute', async () => {
  await runSession('t6', async ({ wv }) => {
    await clickTab(wv, 'Library')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Library")', { label: 'Library heading' })
    await wv.clickButtonByText('Gear')
    await wv.waitFor('document.body.innerText.includes("Shoe & bike mileage tracker")', { label: 'Gear subtab' })
    const gearBeforeText = await wv.waitFor(`(() => {
      const card = [...document.querySelectorAll('.gear-card')].find(c => c.textContent.includes('Pixel 9a Runner'));
      return card ? card.textContent : false;
    })()`, { label: 'Pixel 9a Runner gear before T6' })
    const gearBeforeKm = parseDistanceKm(gearBeforeText)

    await wv.clickButtonByText('Routes')
    await wv.waitFor('document.body.innerText.includes("Saved GPS & GPX routes")', { label: 'Routes subtab' })

    // Trigger GPX file import via DataTransfer
    const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="openGym E2E">
  <trk>
    <name>Zurich Lakefront Loop</name>
    <trkseg>
      <trkpt lat="47.3660" lon="8.5417"><ele>408</ele><time>2026-11-24T09:00:00Z</time></trkpt>
      <trkpt lat="47.3690" lon="8.5417"><ele>412</ele><time>2026-11-24T09:02:00Z</time></trkpt>
      <trkpt lat="47.3720" lon="8.5417"><ele>418</ele><time>2026-11-24T09:04:00Z</time></trkpt>
      <trkpt lat="47.3750" lon="8.5417"><ele>425</ele><time>2026-11-24T09:06:00Z</time></trkpt>
      <trkpt lat="47.3780" lon="8.5417"><ele>431</ele><time>2026-11-24T09:08:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`

    await wv.evalJs(`(() => {
      const input = document.querySelector('.routes-section input[type="file"]');
      if (!input) throw new Error('GPX file input not found');
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(gpxXml)}], 'zurich-loop.gpx', { type: 'application/gpx+xml' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)

    await wv.waitFor('document.body.innerText.includes("GPS trackpoints")', { label: 'GPX Import dialog parsed' })
    await captureUX(wv, '21-gpx-import-dialog')
    await wv.clickButtonByText('Import as Route')
    await wv.waitFor('document.body.innerText.includes("Zurich Lakefront Loop")', { label: 'Imported route card' })

    // Start OS mock GPS provider and navigate to Record GPS Cardio
    await startMockGps()
    let offRouteVisible = false
    let ptsLabel = ''
    let summaryDistanceText = ''
    let summaryKm = 0
    try {
      await wv.clickSelector('#tabbar button.start')
      await wv.waitForSelector('[data-testid="start-hub-sheet"]')
      await wv.clickSelector('[data-testid="quick-action-gps-cardio"]')
      await wv.waitForSelector('[data-testid="recording-idle"]')

      // Verify default shoe ("Pixel 9a Runner") is auto-selected
      const selectedGearText = await wv.evalJs(`(() => {
        const sel = document.querySelector('[data-testid="gear-selector"]');
        return sel?.options?.[sel.selectedIndex]?.text || '';
      })()`)
      assert.ok(selectedGearText.includes('Pixel 9a Runner'), `Default gear must auto-select, got: ${selectedGearText}`)

      // Select imported route in Follow Route selector
      await wv.evalJs(`(() => {
        const sel = document.querySelector('[data-testid="route-selector"]');
        const opt = [...sel.options].find(o => o.text.includes('Zurich Lakefront Loop'));
        if (!opt) throw new Error('Imported route option not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, opt.value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`)
      await captureUX(wv, '22-recording-idle-setup')

      await wv.clickSelector('[data-testid="start-recording-btn"]')
      await wv.waitForSelector('[data-testid="recording-live-screen"]')

      // Push 3 on-route fixes + 1 off-route fix (~510m east) spaced >1s apart for LocationManager minTime=1000ms
      const fixes = [
        { lat: 47.3660, lon: 8.5417 },
        { lat: 47.3690, lon: 8.5422 },
        { lat: 47.3720, lon: 8.5417 },
        { lat: 47.3750, lon: 8.5485 }, // ~510m east -> triggers off-route (>100m)
      ]
      for (const f of fixes) {
        await pushMockGpsFix(f.lat, f.lon, { accuracy: 4.0 })
        await sleep(1150)
      }

      ptsLabel = await wv.waitFor(`(() => {
        const el = document.querySelector('[data-testid="points-count-label"]');
        return el && parseInt(el.textContent, 10) >= 4 ? el.textContent : false;
      })()`, { timeoutMs: 10000, label: '4 GPS points received' })

      offRouteVisible = await wv.evalJs('Boolean(document.querySelector(\'[data-testid="off-route-banner"]\'))')
      await captureUX(wv, '23-recording-live-off-route')

      // Long-press Hold to Finish (1200ms threshold)
      await wv.evalJs(`(() => {
        const btn = document.querySelector('[data-testid="finish-btn"]');
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      })()`)
      await wv.waitForSelector('[data-testid="recording-summary"]', { timeoutMs: 10000 })
      summaryDistanceText = await wv.evalJs('document.querySelector(\'[data-testid="summary-distance"]\')?.textContent?.trim() || ""')
      const summaryRateText = await wv.evalJs('document.querySelector(\'[data-testid="summary-rate"]\')?.textContent?.trim() || ""')
      summaryKm = parseDistanceKm(summaryDistanceText)
      assert.ok(summaryKm > 0, `Summary distance must be > 0 km, got: ${summaryDistanceText}`)
      assert.equal(
        summaryRateText.includes('300:00') || summaryRateText.includes('359:44'),
        false,
        `Summary rate must not show broken pace, got: ${summaryRateText}`
      )
      await captureUX(wv, '24-recording-summary')
      await wv.clickSelector('[data-testid="summary-done-btn"]')
      await wv.waitForSelector('[data-testid="home-today-card"]')
    } finally {
      await stopMockGps()
      // Ensure recording is cleaned up if finish failed so T7/T8 start clean
      const stillLive = await wv.evalJs('Boolean(document.querySelector(\'[data-testid="discard-btn"]\'))').catch(() => false)
      if (stillLive) {
        await wv.evalJs('window.confirm = () => true').catch(() => {})
        await wv.clickSelector('[data-testid="discard-btn"]').catch(() => {})
        await wv.waitForSelector('[data-testid="home-today-card"]').catch(() => {})
      }
    }

    // Check if finished GPS run persisted to Recent Activity and off-route banner appeared
    assert.equal(offRouteVisible, true, `off-route-banner must appear after ${ptsLabel}`)
    const liveRunPersisted = await wv.evalJs(`(() => {
      const items = [...document.querySelectorAll('[data-testid="unified-recent-activity"] .item')];
      return items.some(el =>
        el.textContent.includes(${JSON.stringify(summaryDistanceText)}) ||
        el.textContent.includes('1.3 km') ||
        el.textContent.includes('1.28')
      );
    })()`)
    assert.equal(liveRunPersisted, true, 'Completed GPS run must persist to Recent Activity')

    const recentRows = await wv.evalJs('[...document.querySelectorAll(\'[data-testid="unified-recent-activity"] .item\')].map(el => el.textContent)')
    for (const row of recentRows) {
      assert.equal(row.includes('Invalid Date'), false, `Recent Activity row must not contain Invalid Date: ${row}`)
      assert.equal(row.includes('359:44'), false, `Recent Activity row must not contain 359:44: ${row}`)
      assert.equal(row.includes('300:00'), false, `Recent Activity row must not contain 300:00: ${row}`)
    }
    const t5Row = recentRows.find(t => t.includes('5 km') && t.includes('25 min'))
    assert.ok(t5Row && t5Row.includes('5:00 min/km'), `T5 Recent Activity row must show 5:00 min/km, got: ${t5Row}`)

    // Import GPX as Past Activity so we also verify & capture ActivityDetail track/trim/elevation/save-route screens
    await clickTab(wv, 'Library')
    await wv.waitFor('document.querySelector("h1")?.textContent.includes("Library")', { label: 'Library heading' })
    await wv.clickButtonByText('Routes')
    await wv.evalJs(`(() => {
      const input = document.querySelector('.routes-section input[type="file"]');
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(gpxXml)}], 'zurich-act.gpx', { type: 'application/gpx+xml' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await wv.waitFor('document.body.innerText.includes("Import as Activity") || document.body.innerText.includes("Import as Route")', { label: 'GPX Import dialog for activity' })
    await wv.clickButtonByText('Past Activity')
    await wv.clickButtonByText('Import as Activity')
    await wv.waitFor('document.querySelector(".tiles") === null || document.body.innerText.includes("Activity imported")', { label: 'GPX imported as activity' })

    // Open the GPX-imported track activity in ActivityDetail (/cardio/:id)
    await clickTab(wv, 'Home')
    await wv.waitForSelector('[data-testid="unified-recent-activity"]')
    const openedTrackAct = await wv.waitFor(`(() => {
      const items = [...document.querySelectorAll('[data-testid="unified-recent-activity"] .item')];
      const target = items.find(el => el.textContent.includes('Zurich Lakefront Loop'));
      if (!target) return false;
      target.click();
      return true;
    })()`, { label: 'open GPX track activity in Recent Activity' })
    assert.equal(openedTrackAct, true)
    await wv.waitForSelector('[data-testid="activity-detail-view"]')
    await assertCompactActivityTopbar(wv, 'T6 GPX activity')
    await wv.waitForSelector('[data-testid="trim-toggle-btn"]')
    await wv.waitForSelector('[data-testid="correct-elevation-btn"]')
    await wv.waitForSelector('[data-testid="save-route-btn"]')
    const gpxPre = await wv.evalJs(`(() => ({
      rate: document.querySelector('[data-testid="kpi-rate"]')?.textContent?.trim() || '',
      date: document.querySelector('[data-testid="activity-date"]')?.textContent?.trim() || '',
    }))()`)
    assert.ok(gpxPre.rate.includes('6:00 min/km'), `GPX ActivityDetail kpi-rate must show 6:00 min/km, got: ${gpxPre.rate}`)
    assert.ok(gpxPre.date.length > 0 && !gpxPre.date.includes('Invalid Date'), `GPX ActivityDetail activity-date must be valid, got: ${gpxPre.date}`)
    await captureUX(wv, '25-activity-detail-gps-track')

    // Test Track Trim UI
    await wv.clickSelector('[data-testid="trim-toggle-btn"]')
    await wv.waitForSelector('[data-testid="trim-controls"]')
    const trimSliders = await wv.evalJs(`(() => {
      const tc = document.querySelector('[data-testid="trim-controls"]');
      return tc ? {
        roleSliders: tc.querySelectorAll('[role="slider"]').length,
        rangeInputs: tc.querySelectorAll('input[type="range"]').length,
      } : null;
    })()`)
    assert.deepEqual(trimSliders, { roleSliders: 2, rangeInputs: 0 }, 'trim-controls must have 2 [role="slider"] and 0 input[type="range"]')
    await captureUX(wv, '26-activity-detail-trim')
    await wv.clickSelector('[data-testid="trim-save-btn"]')
    await wv.waitFor('document.querySelector(\'[data-testid="trim-controls"]\') === null', { label: 'Trim saved' })
    const gpxPostTrim = await wv.evalJs(`(() => ({
      rate: document.querySelector('[data-testid="kpi-rate"]')?.textContent?.trim() || '',
      date: document.querySelector('[data-testid="activity-date"]')?.textContent?.trim() || '',
    }))()`)
    assert.ok(gpxPostTrim.rate.includes('6:00 min/km'), `Post-trim kpi-rate must show 6:00 min/km, got: ${gpxPostTrim.rate}`)
    assert.ok(gpxPostTrim.date.length > 0 && !gpxPostTrim.date.includes('Invalid Date'), `Post-trim activity-date must be valid, got: ${gpxPostTrim.date}`)

    // Test Correct Elevation privacy consent gate
    await wv.clickSelector('[data-testid="correct-elevation-btn"]')
    await wv.waitFor('document.body.innerText.includes("DEM Elevation Lookup")', { label: 'Elevation ConsentSheet' })
    assert.equal(await wv.evalJs('Boolean(document.querySelector(".consent-sheet .card"))'), true, 'Elevation ConsentSheet must render .consent-sheet .card')
    await captureUX(wv, '27-elevation-consent-sheet')
    await wv.clickButtonByText('Not now')
    await wv.waitFor('document.querySelector(".consent-sheet") === null', { label: 'Elevation ConsentSheet closed' })

    // Test Save as Route
    await wv.clickSelector('[data-testid="save-route-btn"]')
    await wv.waitFor('document.body.innerText.includes("Saved as route")', { label: 'Saved as route toast' })

    // Verify Gear mileage single-counted on "Pixel 9a Runner"
    await clickTab(wv, 'Library')
    await wv.clickButtonByText('Gear')
    await wv.waitFor('document.body.innerText.includes("Shoe & bike mileage tracker")', { label: 'Gear subtab after T6' })
    const gearAfterText = await wv.waitFor(`(() => {
      const card = [...document.querySelectorAll('.gear-card')].find(c => c.textContent.includes('Pixel 9a Runner'));
      return card ? card.textContent : false;
    })()`, { label: 'Pixel 9a Runner gear after T6' })
    const gearAfterKm = parseDistanceKm(gearAfterText)
    assert.ok(gearAfterKm > gearBeforeKm, `Default gear mileage must increment (${gearBeforeKm} -> ${gearAfterKm})`)
    assert.ok(
      Math.abs((gearAfterKm - gearBeforeKm) - summaryKm) <= 0.25,
      `Gear mileage delta (${(gearAfterKm - gearBeforeKm).toFixed(2)} km) must match single GPS run (${summaryKm} km)`
    )
  })
})

test('T7: GPS cardio foreground service lifecycle, 3s background survival & location permission revoked fallback', async () => {
  await runSession('t7', async ctx => {
    let { wv } = ctx
    await clickTab(wv, 'Home')
    await wv.waitForSelector('[data-testid="home-today-card"]')
    await wv.clickSelector('#tabbar button.start')
    await wv.waitForSelector('[data-testid="start-hub-sheet"]')
    await wv.clickSelector('[data-testid="quick-action-gps-cardio"]')
    await wv.waitForSelector('[data-testid="recording-idle"]')

    assert.equal(await wv.evalJs('document.querySelector(\'[data-testid="web-fallback-banner"]\') === null'), true)

    await wv.clickSelector('[data-testid="sport-btn-run"]')
    await wv.clickSelector('[data-testid="start-recording-btn"]')
    await wv.waitForSelector('[data-testid="recording-live-screen"]')

    await pollUntil(async () => {
      const dump = await getServiceDump(PKG, SVC)
      return dump.includes('isForeground=true') && /(location|0x0*8\b)/i.test(dump)
    }, { label: 'FGS location service active' })

    await pollUntil(async () => {
      const dump = await getNotificationDump()
      return hasActiveNotif(dump) && dump.includes('opengym_cardio_tracking')
    }, { label: 'FGS notification 4201 active' })

    await backgroundApp()
    await sleep(3000)

    const bgDump = await getServiceDump(PKG, SVC)
    assert.ok(bgDump.includes('isForeground=true'), `Service lost foreground while backgrounded:\n${bgDump}`)

    const log = await getCrashLogcat()
    for (const bad of ['FATAL EXCEPTION', 'SecurityException', 'ForegroundServiceStartNotAllowedException']) {
      assert.ok(!log.includes(bad), `Unexpected ${bad} in logcat:\n${log}`)
    }
    assert.equal(wv.errors.length, 0, `Unexpected JS errors: ${wv.errors.join('; ')}`)

    await foregroundApp(PKG)
    await wv.waitForSelector('[data-testid="recording-live-screen"]')

    await wv.evalJs('window.confirm = () => true')
    await wv.clickSelector('[data-testid="discard-btn"]')
    await wv.waitForSelector('[data-testid="home-today-card"]')

    await pollUntil(async () => {
      const dump = await getServiceDump(PKG, SVC)
      return !dump.includes('isForeground=true')
    }, { label: 'FGS stopped after discard' })

    await pollUntil(async () => {
      const dump = await getNotificationDump()
      return !hasActiveNotif(dump)
    }, { label: 'FGS notification cleared after discard' })

    // Revoking runtime permissions kills the app process on Android — close WebView, revoke, and relaunch
    await wv.close()
    ctx.wv = null
    await revokeLocationPermissions(PKG)
    try {
      await launchApp(PKG)
      ctx.wv = wv = await connectWebView(PKG)
      await wv.waitForSelector('[data-testid="home-today-card"]')
      await wv.clickSelector('#tabbar button.start')
      await wv.waitForSelector('[data-testid="start-hub-sheet"]')
      await wv.clickSelector('[data-testid="quick-action-gps-cardio"]')
      await wv.waitForSelector('[data-testid="recording-idle"]')
      await wv.clickSelector('[data-testid="start-recording-btn"]')
      await wv.waitForSelector('[data-testid="recording-live-screen"], [data-testid="recording-error-banner"]')
      await sleep(800)

      const dump = await getServiceDump(PKG, SVC)
      assert.equal(dump.includes('isForeground=true'), false, 'FGS must not start when location permission is revoked')

      const hasBanner = await wv.evalJs('Boolean(document.querySelector(\'[data-testid="recording-error-banner"]\'))')
      if (!hasBanner) {
        await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK'], { ignoreError: true })
        await sleep(300)
      }

      await wv.waitForSelector('[data-testid="recording-idle"]')
      await wv.waitForSelector('[data-testid="recording-error-banner"]')
      const bannerText = await wv.evalJs('document.querySelector(\'[data-testid="recording-error-banner"]\')?.innerText || ""')
      assert.ok(bannerText.includes('Location permission denied'), `Expected permission denied banner, got: ${bannerText}`)
      assert.ok(bannerText.includes('Permissions → Location'), `Expected Settings guidance in banner, got: ${bannerText}`)
      const openSettingsText = await wv.evalJs('document.querySelector(\'[data-testid="open-settings-btn"]\')?.innerText || ""')
      assert.ok(openSettingsText.includes('Open Settings'), `Expected Open Settings button, got: ${openSettingsText}`)

      await pollUntil(async () => !(await appFileExists(PKG, 'opengym-cardio-recovery.log')), {
        label: 'recovery log cleared after permission denial',
      })
      assert.equal(wv.errors.length, 0, `Unexpected WebView errors: ${wv.errors.join('; ')}`)
      await captureUX(wv, '28-recording-permission-revoked')

      await wv.clickSelector('[data-testid="open-settings-btn"]')
      await pollUntil(async () => {
        const winDump = await adb(['shell', 'dumpsys', 'window', 'windows'], { ignoreError: true })
        return winDump.includes('com.android.settings')
      }, { label: 'Android app settings opened' })

      await grantPermissions(PKG)

      for (let i = 0; i < 2; i++) {
        await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK'], { ignoreError: true })
        await sleep(500)
        const winDump = await adb(['shell', 'dumpsys', 'window', 'windows'], { ignoreError: true })
        if (!winDump.includes('com.android.settings')) break
      }
      const resumedWinDump = await adb(['shell', 'dumpsys', 'window', 'windows'], { ignoreError: true })
      if (resumedWinDump.includes('com.android.settings') || !resumedWinDump.includes(PKG)) {
        await foregroundApp(PKG)
      }

      await pollUntil(async () => {
        const banner = await wv.evalJs('document.querySelector(\'[data-testid="recording-error-banner"]\')')
        return banner === null
      }, { label: 'permission error banner cleared on resume' })
      assert.equal(wv.errors.length, 0, `Unexpected WebView errors after resume: ${wv.errors.join('; ')}`)
    } finally {
      await grantPermissions(PKG)
    }
  })
})

test('T8: crash-safe cardio recovery prompt after force-stop & UX audit metrics export', async () => {
  await grantPermissions(PKG)
  await forceStop(PKG)
  await launchApp(PKG)
  await runSession('t8', async ctx => {
    let { wv } = ctx
    await wv.waitForSelector('[data-testid="home-today-card"]')
    await wv.clickSelector('#tabbar button.start')
    await wv.waitForSelector('[data-testid="start-hub-sheet"]')
    await wv.clickSelector('[data-testid="quick-action-gps-cardio"]')
    await wv.waitForSelector('[data-testid="recording-idle"]')
    await wv.clickSelector('[data-testid="sport-btn-run"]')
    await wv.clickSelector('[data-testid="start-recording-btn"]')
    await wv.waitForSelector('[data-testid="recording-live-screen"]')

    await pollUntil(() => appFileExists(PKG, 'opengym-cardio-recovery.log'), {
      label: 'opengym-cardio-recovery.log exists',
    })

    await wv.close()
    ctx.wv = null
    await forceStop(PKG)
    await launchApp(PKG)
    ctx.wv = wv = await connectWebView(PKG)

    await wv.waitFor('document.body.innerText.includes("Recover interrupted cardio?")', {
      timeoutMs: 20000,
      label: 'recovery prompt',
    })
    await captureUX(wv, '29-crash-recovery-sheet')
    await wv.clickButtonByText('Discard')

    await wv.waitFor('!document.body.innerText.includes("Recover interrupted cardio?")', {
      label: 'recovery prompt dismissed',
    })
    await pollUntil(async () => !(await appFileExists(PKG, 'opengym-cardio-recovery.log')), {
      label: 'opengym-cardio-recovery.log removed',
    })
  })
})

after(async () => {
  await mkdir(AUDIT_DIR, { recursive: true })
  await writeFile(`${AUDIT_DIR}/metrics.json`, JSON.stringify(uxAudits, null, 2))
})
