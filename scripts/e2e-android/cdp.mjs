import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let cachedSerial = process.env.ANDROID_SERIAL || null

export async function resolveSerial() {
  if (cachedSerial) return cachedSerial
  const { stdout } = await execFileAsync('adb', ['devices'])
  const lines = stdout.split('\n').slice(1).map(l => l.trim()).filter(Boolean)
  const dev = lines.find(l => /\tdevice$/.test(l))
  if (!dev) throw new Error(`No online Android device found in "adb devices":\n${stdout}`)
  cachedSerial = dev.split('\t')[0]
  return cachedSerial
}

export async function adb(args, { serial, ignoreError = false, noSerial = false } = {}) {
  const s = noSerial ? null : (serial || (await resolveSerial()))
  const full = s ? ['-s', s, ...args] : args
  try {
    const { stdout } = await execFileAsync('adb', full, { maxBuffer: 10 * 1024 * 1024 })
    return stdout
  } catch (err) {
    if (ignoreError) return err.stdout || ''
    throw new Error(`adb ${full.join(' ')} failed: ${err.stderr || err.message}`)
  }
}

export async function wakeScreen(serial) {
  await adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { serial, ignoreError: true })
  await adb(['shell', 'wm', 'dismiss-keyguard'], { serial, ignoreError: true })
}

export async function grantPermissions(pkg, serial) {
  for (const p of [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.POST_NOTIFICATIONS',
  ]) {
    await adb(['shell', 'pm', 'grant', pkg, p], { serial, ignoreError: true })
  }
}

export async function revokeLocationPermissions(pkg, serial) {
  for (const p of [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
  ]) {
    await adb(['shell', 'pm', 'revoke', pkg, p], { serial, ignoreError: true })
  }
}

export async function startMockGps(serial) {
  await adb(['shell', 'appops', 'set', 'com.android.shell', 'android:mock_location', 'allow'], { serial, ignoreError: true })
  await adb(['shell', 'cmd', 'location', 'providers', 'remove-test-provider', 'gps'], { serial, ignoreError: true })
  await adb([
    'shell', 'cmd', 'location', 'providers', 'add-test-provider', 'gps',
    '--supportsAltitude', '--supportsSpeed', '--supportsBearing',
  ], { serial })
  await adb(['shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', 'gps', 'true'], { serial })
}

export async function pushMockGpsFix(lat, lon, { accuracy = 4.0, serial } = {}) {
  await adb([
    'shell', 'cmd', 'location', 'providers', 'set-test-provider-location', 'gps',
    '--location', `${lat},${lon}`,
    '--accuracy', String(accuracy),
    '--time', String(Date.now()),
  ], { serial })
}

export async function stopMockGps(serial) {
  await adb(['shell', 'cmd', 'location', 'providers', 'remove-test-provider', 'gps'], { serial, ignoreError: true })
}

export async function deviceScreenshot(filePath, serial) {
  const s = serial || (await resolveSerial())
  const { stdout } = await execFileAsync('adb', ['-s', s, 'exec-out', 'screencap', '-p'], {
    encoding: 'buffer',
    maxBuffer: 25 * 1024 * 1024,
  })
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, stdout)
}

export const clearApp = (pkg, serial) => adb(['shell', 'pm', 'clear', pkg], { serial })
export const forceStop = (pkg, serial) => adb(['shell', 'am', 'force-stop', pkg], { serial })
export const launchApp = (pkg, serial) => adb(['shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`], { serial })
export const backgroundApp = serial => adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'], { serial })
export const foregroundApp = (pkg, serial) => adb(['shell', 'am', 'start', '-W', '-n', `${pkg}/.MainActivity`], { serial })
export const clearLogcat = serial => adb(['logcat', '-c'], { serial, ignoreError: true })

export async function getCrashLogcat(serial) {
  return adb(['logcat', '-d', '-b', 'main,crash,system'], { serial, ignoreError: true })
}

export function getServiceDump(pkg, serviceName = '.BackgroundLocationService', serial) {
  return adb(['shell', 'dumpsys', 'activity', 'services', `${pkg}/${serviceName}`], { serial, ignoreError: true })
}

export async function getNotificationDump(serial) {
  return adb(['shell', 'dumpsys', 'notification', '--noredact'], { serial, ignoreError: true })
}

export async function appFileExists(pkg, relPath, serial) {
  const s = serial || (await resolveSerial())
  try {
    await execFileAsync('adb', ['-s', s, 'shell', 'run-as', pkg, 'test', '-f', `files/${relPath}`])
    return true
  } catch {
    return false
  }
}

export async function connectWebView(pkg, { port = 9222, timeoutMs = 20000, serial } = {}) {
  const s = serial || (await resolveSerial())
  const deadline = Date.now() + timeoutMs
  let pid = ''
  while (Date.now() < deadline) {
    const out = (await adb(['shell', 'pidof', pkg], { serial: s, ignoreError: true })).trim()
    if (/^\d+/.test(out)) { pid = out.split(/\s+/)[0]; break }
    await sleep(250)
  }
  if (!pid) throw new Error(`Timed out waiting for pidof ${pkg}`)

  let target = null
  let forwarded = false
  let ws = null
  try {
    while (Date.now() < deadline) {
      let sock = `webview_devtools_remote_${pid}`
      try {
        await adb(['forward', `tcp:${port}`, `localabstract:${sock}`], { serial: s })
        forwarded = true
        const res = await fetch(`http://127.0.0.1:${port}/json`)
        if (res.ok) {
          const pages = await res.json()
          target = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl)
          if (target) break
        }
      } catch {}
      // Fallback: inspect /proc/net/unix for WebView devtools socket
      const unix = await adb(['shell', 'cat', '/proc/net/unix'], { serial: s, ignoreError: true })
      const matches = [...unix.matchAll(/@(webview_devtools_remote_\d+)/g)].map(m => m[1])
      sock = matches.find(m => m.endsWith(`_${pid}`)) || matches[matches.length - 1]
      if (sock) {
        try {
          await adb(['forward', `tcp:${port}`, `localabstract:${sock}`], { serial: s })
          forwarded = true
          const res = await fetch(`http://127.0.0.1:${port}/json`)
          if (res.ok) {
            const pages = await res.json()
            target = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl)
            if (target) break
          }
        } catch {}
      }
      await sleep(300)
    }
    if (!target) throw new Error(`Timed out waiting for WebView CDP page target on port ${port}`)

    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket open timeout')), 10000)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      ws.addEventListener('error', e => { clearTimeout(t); reject(e.error || new Error('WebSocket error')) }, { once: true })
    })

    let nextId = 1
    const pending = new Map()
    const errors = []
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`))
        else resolve(msg.result)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        errors.push(d?.exception?.description || d?.text || JSON.stringify(d))
      }
    })

    const send = (method, params = {}, callTimeoutMs = 15000) => new Promise((resolve, reject) => {
      const id = nextId++
      const t = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP ${method} timed out (${callTimeoutMs}ms)`))
      }, callTimeoutMs)
      pending.set(id, {
        resolve: v => { clearTimeout(t); resolve(v) },
        reject: e => { clearTimeout(t); reject(e) },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Log.enable')

    const evalJs = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) {
        const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text
        throw new Error(`evalJs failed: ${msg}`)
      }
      return r.result?.value
    }
    const waitFor = async (fnOrExpr, { timeoutMs: ms = 15000, intervalMs = 200, label = 'condition' } = {}) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        try {
          const val = typeof fnOrExpr === 'function' ? await fnOrExpr() : await evalJs(fnOrExpr)
          if (val) return val
        } catch {}
        await sleep(intervalMs)
      }
      throw new Error(`Timed out waiting for ${label} (${ms}ms)`)
    }
    const waitForSelector = (sel, opts) =>
      waitFor(`Boolean(document.querySelector(${JSON.stringify(sel)}))`, { label: `selector ${sel}`, ...opts })
    const clickSelector = async (sel, opts) => {
      await waitForSelector(sel, opts)
      return evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`)
    }
    const clickButtonByText = async (text, opts) => {
      const expr = `(() => {
        const q = ${JSON.stringify(text)};
        const els = [...document.querySelectorAll('button, [role="button"], .btn, .item, .lrow')].filter(e => !e.disabled && e.getClientRects().length > 0);
        const target = els.find(e => e.textContent.trim() === q) || els.find(e => e.textContent.includes(q));
        if (!target) return false;
        target.scrollIntoView({ block: 'center' });
        target.click();
        return true;
      })()`
      return waitFor(expr, { label: `button "${text}"`, ...opts })
    }
    const bodyText = () => evalJs('document.body?.innerText || ""')
    const screenshot = async filePath => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, Buffer.from(data, 'base64'))
    }
    const auditUX = async screenName => {
      return evalJs(`(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rootStyle = getComputedStyle(document.documentElement);
        const appEl = document.getElementById('app');
        const appStyle = appEl ? getComputedStyle(appEl) : null;
        const rectOf = sel => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
        };
        const interactives = [...document.querySelectorAll('button, a, select, input:not([type="hidden"]):not([type="file"]), [role="button"], [role="switch"], .today-row, .wday')];
        const undersizedTargets = [];
        for (const el of interactives) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.bottom < 0 || r.top > vh) continue;
          if (r.width < 44 || r.height < 44) {
            const label = (el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50);
            undersizedTargets.push({
              tag: el.tagName.toLowerCase(),
              className: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
              label,
              width: Math.round(r.width),
              height: Math.round(r.height),
              top: Math.round(r.top),
              severity: (r.width < 36 || r.height < 36) ? 'critical' : 'warning'
            });
          }
        }
        const overflows = [];
        for (const el of document.querySelectorAll('.hdr, .card, .item, .lrow, .sheet, .today-row')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(el);
          if (el.scrollWidth > el.clientWidth + 4 && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') {
            overflows.push({
              tag: el.tagName.toLowerCase(),
              className: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
              text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50)
            });
          }
        }
        const aboveTheFold = [...document.querySelectorAll('h1, h2, h3, h4.sec, [data-testid="home-today-card"], [data-testid="home-onboarding-chooser"], [data-testid="home-week-glance"], [data-testid="unified-recent-activity"], .btn.primary')]
          .map(el => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              testid: el.getAttribute('data-testid') || null,
              text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              visibleInViewport: r.height > 0 && r.top >= 0 && r.top < vh
            };
          })
          .filter(x => x.visibleInViewport)
          .sort((a, b) => a.top - b.top);

        return {
          screenName: ${JSON.stringify(screenName)},
          hash: window.location.hash,
          theme: document.documentElement.dataset.theme || 'dark',
          viewport: { width: vw, height: vh, dpr: window.devicePixelRatio },
          safeArea: {
            sat: rootStyle.getPropertyValue('--sat').trim(),
            sab: rootStyle.getPropertyValue('--sab').trim(),
            appPaddingTop: appStyle ? appStyle.paddingTop : null,
            appPaddingBottom: appStyle ? appStyle.paddingBottom : null,
          },
          headerRect: rectOf('.hdr, .recording-header, .flow-player-view > .row:first-child'),
          tabbarRect: rectOf('#tabbar'),
          sheetRect: rectOf('.sheet'),
          undersizedCount: undersizedTargets.length,
          criticalUndersizedCount: undersizedTargets.filter(t => t.severity === 'critical').length,
          undersizedTargets,
          overflows,
          aboveTheFold,
        };
      })()`)
    }
    const close = async () => {
      try { if (ws && ws.readyState <= WebSocket.OPEN) ws.close() } catch {}
      finally { await adb(['forward', '--remove', `tcp:${port}`], { serial: s, ignoreError: true }) }
    }
    return { evalJs, waitFor, waitForSelector, clickSelector, clickButtonByText, bodyText, screenshot, auditUX, errors, close }
  } catch (err) {
    try { if (ws && ws.readyState <= WebSocket.OPEN) ws.close() } catch {}
    if (forwarded) await adb(['forward', '--remove', `tcp:${port}`], { serial: s, ignoreError: true })
    throw err
  }
}
