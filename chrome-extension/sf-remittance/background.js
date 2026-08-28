import { getConfig, setStatus } from './store.js'
import { fetchQueue, postResult, fetchNoteQueue, postNoteResult, postVendorOrders, postAlert } from './app-api.js'
import { applyOne } from './sf.js'
import { postNote } from './sf-note.js'

const ALARM = 'sf-remittance-poll'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function scheduleAlarm() {
  const { pollMinutes } = await getConfig()
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, Number(pollMinutes) || 10) })
}

const SF_RECOVER_ALARM = 'sf-session-recover'
const SF_KEEPALIVE_ALARM = 'sf-session-keepalive'
const CRAWL_TZ = 'America/Los_Angeles'
const CRAWL_TIMEOUT_MS = 20 * 60 * 1000

// ── Scheduled vendor-portal crawls (Genie + Clopay share one engine) ────────
// An always-on office PC runs these: hourly during work hours (incremental — just
// new/changed orders) plus a nightly full backfill. The alarm fires hourly and
// the handler decides what (if anything) to run based on the PT clock. Each crawl
// opens a background tab to the order list; the content script does the work and
// signals completion, then we close the tab. A timeout alarm force-closes a tab
// that never finishes. State lives in chrome.storage (the MV3 worker is ephemeral).
//
// Every crawler is one descriptor here — its portal URL, its own storage keys /
// alarm names (so Genie and Clopay never step on each other), the option flags
// that gate it, and the login/alert source names. All the machinery below is
// parameterized by the descriptor, so adding a portal is one entry + its content
// script.
const CRAWLERS = {
  genie: {
    name: 'genie', vendor: 'genie_thd',
    listUrl: 'https://install.openings.net/webcenter/portal/installerconnect/orderlist',
    stateKey: 'genieCrawl', modeKey: 'genieCrawlMode',
    alarm: 'genie-crawl', timeoutAlarm: 'genie-crawl-timeout',
    scheduleFlag: 'genieScheduleEnabled', enabledFlag: 'genieEnabled',
    loginFlag: 'genie-login-detected', alertSource: 'genie',
  },
  clopay: {
    name: 'clopay', vendor: 'clopay_hd',
    // Start at the Clopay IAM login URL (per Castle — this stable entry point does
    // not expire): content-login signs in on prod-iam, the OIDC flow returns to
    // cca.clopay.com, and content-clopay's cca handler clicks HD Program →
    // hdprogram.clopay.com/orders. Opening /orders directly does NOT bounce to
    // login, so a logged-out crawl would just sit on a blank page.
    listUrl: 'https://prod-iam.clopay.com/Account/Login?ReturnUrl=%2Fconnect%2Fauthorize%2Fcallback%3Fresponse_type%3Dcode%26client_id%3D6f5a9fb9039d422abebe546ef935951b%26state%3DT2dVTzlsfkt4LWJwdDdyYm1tOGJIM1BFNWtmTnZCQ1pfaDFhUmJpLVV4MmlH%26redirect_uri%3Dhttps%253A%252F%252Fcca.clopay.com%252Fsignin-oidc%26scope%3Dopenid%2520profile%26code_challenge%3DFemCme6P6lp59gS8nDRLwOnnnyZgSAWtuHKdUlpHcf8%26code_challenge_method%3DS256%26nonce%3DT2dVTzlsfkt4LWJwdDdyYm1tOGJIM1BFNWtmTnZCQ1pfaDFhUmJpLVV4MmlH',
    // A full detail backfill of ~170 orders takes a while; give it longer before
    // the safety timeout force-closes the tab (the in-page sweep also resumes if
    // it is interrupted).
    timeoutMs: 90 * 60 * 1000,
    stateKey: 'clopayCrawl', modeKey: 'clopayCrawlMode',
    alarm: 'clopay-crawl', timeoutAlarm: 'clopay-crawl-timeout',
    scheduleFlag: 'clopayScheduleEnabled', enabledFlag: 'clopayEnabled',
    loginFlag: 'clopay-login-detected', alertSource: 'clopay',
  },
}
const crawlerByName = (name) => CRAWLERS[name] || null
const crawlerByLoginFlag = (flag) => Object.values(CRAWLERS).find(c => c.loginFlag === flag) || null
const crawlerByIngestType = (type) => CRAWLERS[type] || null // content scripts send type === crawler name

chrome.runtime.onInstalled.addListener(() => { scheduleAlarm(); scheduleAllCrawls(); scheduleSfKeepalive() })
chrome.runtime.onStartup.addListener(() => { scheduleAlarm(); scheduleAllCrawls(); scheduleSfKeepalive() })
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM) return run('alarm')
  if (a.name === SF_RECOVER_ALARM) return finishSfRecover()
  if (a.name === SF_KEEPALIVE_ALARM) return maybeSfKeepalive()
  for (const c of Object.values(CRAWLERS)) {
    if (a.name === c.alarm) return maybeScheduledCrawl(c)
    if (a.name === c.timeoutAlarm) return onCrawlTimeout(c)
  }
})

// A scheduled crawl that never signalled done → it stalled. Close its tab and
// alert, so a silently-broken crawl doesn't go unnoticed.
async function onCrawlTimeout(c) {
  const state = (await chrome.storage.local.get(c.stateKey))[c.stateKey]
  await finishCrawl(c, 'timeout')
  if (state) { setBadge('!'); await notifyAlert(c.alertSource, 'error', 'scheduled crawl did not finish (timed out)') }
}

// delayInMinutes:1 so the schedule also fires ~1 min after Chrome start / an
// extension reload — otherwise each reload restarts a full 60-min countdown and a
// machine that's reloaded/restarted often could go a long time without a crawl.
function scheduleAllCrawls() { for (const c of Object.values(CRAWLERS)) chrome.alarms.create(c.alarm, { delayInMinutes: 1, periodInMinutes: 60 }) }
function scheduleSfKeepalive() { chrome.alarms.create(SF_KEEPALIVE_ALARM, { delayInMinutes: 2, periodInMinutes: 60 }) }

function ptNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: CRAWL_TZ, weekday: 'short', hour: '2-digit', hour12: false })
      .formatToParts(new Date()).map(p => [p.type, p.value]))
  return { hour: Number(parts.hour) % 24, weekday: parts.weekday }
}

async function maybeScheduledCrawl(c) {
  const cfg = await getConfig()
  if (!cfg[c.scheduleFlag]) return
  const { hour, weekday } = ptNow()
  const workday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(weekday)
  let mode = null
  if (hour === 3) mode = 'full'                                   // nightly full backfill ~3am PT
  else if (workday && hour >= 7 && hour <= 18) mode = 'incremental' // 7am–6pm Mon–Sat
  if (!mode) return
  await startCrawl(c, mode)
}

async function tabExists(tabId) {
  if (tabId == null) return false
  try { await chrome.tabs.get(tabId); return true } catch { return false }
}

// mode: 'full' | 'incremental'. force:true (the manual button) always starts a
// fresh crawl. Returns { started, reason }.
async function startCrawl(c, mode, { force = false } = {}) {
  const timeoutMs = c.timeoutMs || CRAWL_TIMEOUT_MS
  const state = (await chrome.storage.local.get(c.stateKey))[c.stateKey]
  // Only treat an existing crawl as "already running" if it's recent AND its tab
  // is actually still open. Stale state (tab closed / worker died / a missed
  // 'done' message) must not block a new crawl — especially the manual button.
  if (state && !force && Date.now() - state.startedAt < timeoutMs && await tabExists(state.tabId)) {
    console.log(`[${c.name}] crawl already running`)
    return { started: false, reason: 'already running' }
  }
  // Force, or leftover state — tear down anything stale before starting fresh.
  if (state) {
    chrome.alarms.clear(c.timeoutAlarm)
    if (state.tabId != null) { try { await chrome.tabs.remove(state.tabId) } catch { /* already closed */ } }
  }
  await chrome.storage.local.set({ [c.modeKey]: mode })
  const tab = await chrome.tabs.create({ url: c.listUrl, active: false })
  await chrome.storage.local.set({ [c.stateKey]: { tabId: tab.id, mode, startedAt: Date.now() } })
  await setStatus({ source: `${c.name}-schedule`, mode, state: 'running' })
  chrome.alarms.create(c.timeoutAlarm, { when: Date.now() + timeoutMs })
  console.log(`[${c.name}] crawl started:`, mode, force ? '(forced)' : '')
  return { started: true }
}

async function finishCrawl(c, reason) {
  const state = (await chrome.storage.local.get(c.stateKey))[c.stateKey]
  chrome.alarms.clear(c.timeoutAlarm)
  await chrome.storage.local.remove([c.stateKey, c.modeKey])
  if (state && state.tabId != null && reason !== 'login') {
    try { await chrome.tabs.remove(state.tabId) } catch { /* already closed */ }
  }
  // The Clopay crawl's document capture uses a hidden debugger-driven helper tab —
  // detach + close it when the crawl ends so no "debugging" tab is left behind.
  if (c.name === 'clopay') { try { await teardownCaptureTab() } catch { /* ignore */ } }
  console.log(`[${c.name}] crawl finished:`, reason)
}

function setBadge(text) {
  try {
    chrome.action.setBadgeText({ text })
    if (text) chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' })
  } catch { /* ignore */ }
}

// Email the chosen recipients about an automation problem (deduped server-side).
async function notifyAlert(source, kind, detail) {
  const cfg = await getConfig()
  if (!cfg.baseUrl || !cfg.token) return
  try { await postAlert(cfg.baseUrl, cfg.token, { source, kind, detail }) } catch (e) { console.warn('[alert] failed', e) }
}

// ── Keep the Service Fusion session warm ─────────────────────────────────────
// SF's session goes stale when nothing touches it in the browser — background
// fetches from the worker then come back non-JSON / bounced even though you're
// still "logged in". A quick navigation refreshes it. So we open
// admin.servicefusion.com in a background tab (which refreshes the session — and,
// if it HAS actually logged out, content-login.js signs back in with saved creds),
// then close it. Runs proactively every hour and reactively on a failed post.
const SF_RECOVER_MS = 45000
async function warmSfSession({ retry = false } = {}) {
  const { sfRecovering } = await chrome.storage.local.get('sfRecovering')
  if (sfRecovering && Date.now() - sfRecovering.at < 3 * 60 * 1000) return // one at a time
  const tab = await chrome.tabs.create({ url: 'https://admin.servicefusion.com/', active: false })
  await chrome.storage.local.set({ sfRecovering: { tabId: tab.id, at: Date.now(), retry } })
  chrome.alarms.create(SF_RECOVER_ALARM, { when: Date.now() + SF_RECOVER_MS })
  console.log('[sf] warming session via admin.servicefusion.com', retry ? '→ will retry queue' : '(keep-alive)')
}

async function finishSfRecover() {
  const { sfRecovering } = await chrome.storage.local.get('sfRecovering')
  await chrome.storage.local.remove('sfRecovering')
  if (sfRecovering && sfRecovering.tabId != null) { try { await chrome.tabs.remove(sfRecovering.tabId) } catch { /* already closed */ } }
  if (sfRecovering && sfRecovering.retry) { console.log('[sf] session refreshed → retrying queued work'); run('sf-recover') }
}

// Hourly proactive keep-alive (only when the background poll is on — i.e. SF
// automation is actually in use).
async function maybeSfKeepalive() {
  const cfg = await getConfig()
  if (!cfg.enabled) return
  await warmSfSession({ retry: false })
}

// Manual "Run now" from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'run-now') { run('manual').then(r => sendResponse(r)); return true }
})

// "Full <portal> crawl now" from the popup — same machinery as a scheduled full
// crawl (opens a background tab, details every order, closes when done), but on
// demand and regardless of the schedule/auto-detail toggles. One handler per
// crawler: 'genie-crawl-now', 'clopay-crawl-now', …
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const c = typeof msg?.type === 'string' && msg.type.endsWith('-crawl-now') ? crawlerByName(msg.type.slice(0, -'-crawl-now'.length)) : null
  if (!c) return
  ;(async () => {
    const cfg = await getConfig()
    if (!cfg.baseUrl || !cfg.token) { sendResponse({ ok: false, error: 'set Castle Admin URL + token in Options' }); return }
    setBadge('')
    // force:true — a manual click always opens a fresh crawl tab, even if stale
    // crawl state is lingering from a previous run.
    const r = await startCrawl(c, 'full', { force: true })
    sendResponse({ ok: !!r.started, error: r.started ? undefined : (r.reason || 'could not start') })
  })()
  return true
})

// A content script asks whether it's running in the extension's crawl tab, so it
// only auto-navigates the portal there (never in the user's own browsing).
// 'genie-crawl-tab?', 'clopay-crawl-tab?', …
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const c = typeof msg?.type === 'string' && msg.type.endsWith('-crawl-tab?') ? crawlerByName(msg.type.slice(0, -'-crawl-tab?'.length)) : null
  if (!c) return
  ;(async () => {
    const state = (await chrome.storage.local.get(c.stateKey))[c.stateKey]
    sendResponse({ isCrawlTab: !!(state && sender.tab && sender.tab.id === state.tabId) })
  })()
  return true
})

// Content scripts signal a scheduled crawl's outcome. 'genie-crawl-done',
// 'clopay-crawl-done', …
chrome.runtime.onMessage.addListener((msg, sender, _sendResponse) => {
  const done = typeof msg?.type === 'string' && msg.type.endsWith('-crawl-done') ? crawlerByName(msg.type.slice(0, -'-crawl-done'.length)) : null
  if (done) {
    ;(async () => {
      const state = (await chrome.storage.local.get(done.stateKey))[done.stateKey]
      // Only act on the crawl's own tab — a manual crawl in a user tab is ignored.
      if (state && sender.tab && sender.tab.id === state.tabId) { setBadge(''); await finishCrawl(done, 'done') }
    })()
    return
  }
  // A login page couldn't be signed into automatically (no saved credentials, or
  // they didn't take / MFA). Badge + email so someone signs in by hand.
  const LOGIN_ALERTS = {
    'genie-login-detected': 'genie',
    'clopay-login-detected': 'clopay',
    'sf-login-detected': 'service_fusion',
    'castle-login-detected': 'castle_admin',
  }
  if (msg?.type && LOGIN_ALERTS[msg.type]) {
    const source = LOGIN_ALERTS[msg.type]
    ;(async () => {
      await setStatus({ source: `${source}-login`, state: 'login_required' })
      setBadge('!')
      await notifyAlert(source, 'logged_out') // email chosen recipients (deduped server-side)
      // If this login belongs to a crawler and the logged-out page IS that
      // crawler's own tab, surface it for one-click login and end the crawl
      // (keeping the tab open so re-auth can happen).
      const c = crawlerByLoginFlag(msg.type)
      if (c) {
        const state = (await chrome.storage.local.get(c.stateKey))[c.stateKey]
        if (state && sender.tab && sender.tab.id === state.tabId) {
          try { await chrome.tabs.update(state.tabId, { active: true }) } catch { /* ignore */ }
          await finishCrawl(c, 'login')
        }
      }
    })()
    return
  }
})

// Proxy Clopay portal-API calls from the content script. The content script reads
// the bearer token from the page's localStorage and asks us to make the request:
// the service worker has host_permissions for *.clopay.com, so it can call the
// cross-origin prod-apigateway.clopay.com host without being blocked by CORS.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'clopay-api') return
  ;(async () => {
    try {
      if (!/^https:\/\/prod-apigateway\.clopay\.com\//.test(msg.url || '')) { sendResponse({ status: 0, error: 'blocked url' }); return }
      const res = await fetch(msg.url, {
        method: msg.method || 'GET',
        headers: {
          authorization: 'Bearer ' + msg.token,
          accept: 'application/json',
          ...(msg.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(msg.body ? { body: JSON.stringify(msg.body) } : {}),
      })
      let json = null
      try { json = await res.json() } catch { /* non-JSON */ }
      sendResponse({ status: res.status, json })
    } catch (e) {
      sendResponse({ status: -1, error: e instanceof Error ? e.message : String(e) })
    }
  })()
  return true // async response
})

// Forward a Clopay document check/upload to Castle's store endpoint with our token.
// With no dataB64 it's a cheap dedup check ({alreadyStored} / {needsUpload}); with
// bytes it stores (upsert). Used by the store-doc message and the capture loop below.
async function storeClopayDoc({ external_id, documentId, filename, mime, dataB64 }) {
  const cfg = await getConfig()
  if (!cfg.baseUrl || !cfg.token) return { ok: false, error: 'not configured' }
  if (!external_id || documentId == null) return { ok: false, error: 'bad args' }
  try {
    const res = await fetch(`${cfg.baseUrl}/api/vendor-orders/attachment/store`, {
      method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'clopay_hd', external_id, documentId, filename, mime, ...(dataB64 ? { dataB64 } : {}) }),
    })
    const j = await res.json().catch(() => ({}))
    return res.ok ? j : { ok: false, error: j.error || `store ${res.status}` }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

// Dedup check (content script) → skip docs we already have before the expensive
// getdocumenturl + navigation capture.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'clopay-store-doc') return
  storeClopayDoc(msg).then(sendResponse)
  return true // async response
})

// ── Clopay generated-document capture (chrome.debugger navigation) ───────────
// Generated Clopay PDFs (New IPO, Blank ICA/LW, … — the majority) are served ONLY to
// a real top-level NAVIGATION to hdprogram.clopay.com/showdocument/{id}.pdf. A fetch
// from ANY context (content script, MAIN world, worker) gets a ~15KB Angular shell,
// because JS cannot set `Sec-Fetch-Mode: navigate` (the browser owns Sec-Fetch-*).
// So we drive a hidden helper tab with the DevTools Protocol: attach the debugger,
// intercept the showdocument response via the Fetch domain, read the real PDF bytes,
// then abort the request (Chrome never has to spin up its PDF viewer). One helper tab
// is reused for the whole crawl and torn down when it finishes. (If Fetch-domain body
// capture ever proves unreliable for a PDF, the fallback is Network.enable +
// Network.getResponseBody on loadingFinished.)
const CAPTURE_PATTERN = '*://hdprogram.clopay.com/showdocument/*'
let captureTabId = null
let captureAttached = false
let pendingCapture = null // { url, resolve } — capture is serial, so at most one

function dbgSend(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (res) => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message)); else resolve(res)
    })
  })
}
function dbgAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message)); else resolve()
    })
  })
}
const urlBase = (u) => (u || '').split('?')[0]

// One global CDP event router. On a paused showdocument RESPONSE, hand its body to the
// waiting capture (matched by URL) and abort the request; anything else continues.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (captureTabId == null || source.tabId !== captureTabId || method !== 'Fetch.requestPaused') return
  const reqId = params.requestId
  const url = params.request && params.request.url
  ;(async () => {
    const p = pendingCapture
    if (p && url && urlBase(url) === urlBase(p.url)) {
      pendingCapture = null
      try {
        const status = params.responseStatusCode || 0
        const body = await dbgSend({ tabId: captureTabId }, 'Fetch.getResponseBody', { requestId: reqId })
        try { await dbgSend({ tabId: captureTabId }, 'Fetch.failRequest', { requestId: reqId, errorReason: 'Aborted' }) } catch { /* ignore */ }
        p.resolve({ ok: true, status, base64: body && body.base64Encoded ? body.body : null })
      } catch (e) {
        try { await dbgSend({ tabId: captureTabId }, 'Fetch.failRequest', { requestId: reqId, errorReason: 'Aborted' }) } catch { /* ignore */ }
        p.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    } else {
      try { await dbgSend({ tabId: captureTabId }, 'Fetch.continueRequest', { requestId: reqId }) } catch { /* ignore */ }
    }
  })()
})
chrome.debugger.onDetach.addListener((source) => { if (source.tabId === captureTabId) captureAttached = false })

async function waitTabComplete(tabId, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { const t = await chrome.tabs.get(tabId); if (t.status === 'complete') return } catch { return }
    await sleep(300)
  }
}

// Lazily create + attach the hidden capture tab, ON the hdprogram origin so the doc
// navigations are same-origin and carry the live session cookie.
async function ensureCaptureTab() {
  if (captureTabId != null && captureAttached && await tabExists(captureTabId)) return
  await teardownCaptureTab()
  const tab = await chrome.tabs.create({ url: 'https://hdprogram.clopay.com/orders', active: false })
  captureTabId = tab.id
  await waitTabComplete(captureTabId)
  await dbgAttach({ tabId: captureTabId })
  captureAttached = true
  await dbgSend({ tabId: captureTabId }, 'Fetch.enable', { patterns: [{ urlPattern: CAPTURE_PATTERN, requestStage: 'Response' }] })
}

async function teardownCaptureTab() {
  const id = captureTabId
  captureTabId = null; captureAttached = false
  if (pendingCapture) { try { pendingCapture.resolve({ ok: false, error: 'torn down' }) } catch { /* ignore */ } pendingCapture = null }
  if (id == null) return
  try { await new Promise(r => chrome.debugger.detach({ tabId: id }, () => { void chrome.runtime.lastError; r() })) } catch { /* ignore */ }
  try { await chrome.tabs.remove(id) } catch { /* already closed */ }
}

// Capture ONE document's PDF bytes by navigating the helper tab to its showdocument
// URL and reading the intercepted response. Serial (one pendingCapture at a time).
async function captureDocBytes(url, timeoutMs = 30000) {
  await ensureCaptureTab()
  let timer = null
  const done = new Promise((resolve) => {
    pendingCapture = { url, resolve }
    timer = setTimeout(() => { if (pendingCapture && pendingCapture.resolve === resolve) { pendingCapture = null; resolve({ ok: false, error: 'timeout' }) } }, timeoutMs)
  })
  try {
    await chrome.tabs.update(captureTabId, { url })
  } catch (e) {
    if (pendingCapture) pendingCapture = null
    clearTimeout(timer)
    return { ok: false, error: 'navigate ' + (e instanceof Error ? e.message : String(e)) }
  }
  const res = await done
  clearTimeout(timer)
  return res
}

// Capture + store a batch of an order's documents (content script sends them after
// resolving each showdocument URL via getdocumenturl, which generates the PDF).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'clopay-capture-docs') return
  ;(async () => {
    const docs = Array.isArray(msg.docs) ? msg.docs : []
    const results = []
    for (const d of docs) {
      if (!d || !d.url || d.documentId == null || !d.external_id) { results.push({ documentId: d && d.documentId, ok: false, error: 'bad args' }); continue }
      const cap = await captureDocBytes(d.url)
      if (!cap.ok || !cap.base64) { results.push({ documentId: d.documentId, ok: false, error: cap.error || `capture ${cap.status || '?'}` }); continue }
      if (!cap.base64.startsWith('JVBER')) { results.push({ documentId: d.documentId, ok: false, error: `not a pdf (${cap.status})` }); continue } // "JVBER" = base64 of "%PDF"
      const store = await storeClopayDoc({ external_id: d.external_id, documentId: d.documentId, filename: d.filename, mime: 'application/pdf', dataB64: cap.base64 })
      results.push({ documentId: d.documentId, ...store })
    }
    sendResponse({ ok: true, results })
  })()
  return true // async response
})

// Orders scraped from a vendor portal (content-genie.js / content-clopay.js) →
// Castle Admin ingest. Independent of the SF poll loop; posts in the user's
// session using the same base URL + token. The content script sends the crawler
// name as `type` (e.g. 'genie', 'clopay') plus the vendor key.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const c = crawlerByIngestType(msg?.type)
  if (!c) return
  ;(async () => {
    const cfg = await getConfig()
    if (cfg[c.enabledFlag] === false) { sendResponse({ ok: false, error: `${c.name} disabled` }); return }
    if (!cfg.baseUrl || !cfg.token) { sendResponse({ ok: false, error: 'not configured' }); return }
    const orders = msg.kind === 'detail' ? [msg.payload] : (msg.payload || [])
    if (!orders.length) { sendResponse({ ok: true, skipped: 'no orders' }); return }
    try {
      const res = await postVendorOrders(cfg.baseUrl, cfg.token, msg.vendor, orders, { kind: msg.kind, mode: msg.mode })
      await setStatus({ source: c.name, vendor: msg.vendor, kind: msg.kind, ingest: res })
      console.log(`[sf-remittance] ${c.name} ingest`, res)
      sendResponse({ ok: true, ...res })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`[sf-remittance] ${c.name} ingest failed`, error)
      sendResponse({ ok: false, error })
    }
  })()
  return true // async response
})

/** Post queued SF job notes. Mirrors the payment pass: dry-run never writes back;
 *  live mode records every outcome. Returns { queued, posted, failed }. */
async function runNotes(cfg, log) {
  let queue
  try {
    queue = await fetchNoteQueue(cfg.baseUrl, cfg.token)
  } catch (e) {
    log.push({ noteQueueError: e instanceof Error ? e.message : String(e) })
    return { queued: 0, posted: 0, failed: 0 }
  }
  const { items } = queue
  console.log('[sf-remittance] note queue', { items: items.length })
  let posted = 0, failed = 0
  for (const item of items) {
    const res = await postNote(item, cfg)
    log.push({ noteId: item.id, event: item.event, jobNumber: item.jobNumber, jobId: item.sfJobId, ...res })
    if (!cfg.dryRun) {
      try {
        await postNoteResult(cfg.baseUrl, cfg.token, {
          id: item.id, ok: res.ok, sfResponse: { trace: res.trace, snippet: res.snippet }, error: res.ok ? undefined : res.error,
        })
      } catch (e) { log.push({ noteId: item.id, callbackError: String(e) }) }
    }
    res.ok ? posted++ : failed++
    // If SF is logged out, every remaining note fails the same way. Stop now so
    // we don't burn their retry budget or hammer SF — the app re-serves failed
    // notes, so they'll post on a later run once SF is signed back in.
    if (!res.ok && /session expired|redirected to login|failed to fetch|login form|got a login/i.test(res.error || '')) {
      log.push({ notesStoppedEarly: 'SF session appears logged out — remaining notes will retry next run' })
      break
    }
    await sleep(1500) // be gentle on SF
  }
  return { queued: items.length, posted, failed }
}

let running = false

export async function run(source) {
  if (running) return { ok: false, error: 'already running' }
  const cfg = await getConfig()
  // The "Enabled" toggle only gates the background poll; "Run now" always runs.
  if (source === 'alarm' && !cfg.enabled) { await setStatus({ source, skipped: 'background poll disabled' }); return { ok: false, error: 'disabled' } }
  if (!cfg.baseUrl || !cfg.token) { await setStatus({ source, error: 'not configured (set base URL + token in Options)' }); return { ok: false, error: 'not configured' } }

  running = true
  const log = []
  let applied = 0, failed = 0
  try {
    let queue
    try {
      queue = await fetchQueue(cfg.baseUrl, cfg.token)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      throw new Error(/fetch/i.test(m) ? `Could not reach Castle Admin at ${cfg.baseUrl} (check the URL / that it's deployed). ${m}` : m)
    }
    const { items, skipped } = queue
    console.log('[sf-remittance] queue', { items: items.length, skipped })
    const isSfLogout = (err) => /session expired|redirected to login|got (?:a )?login|global search did not return json|login\?true/i.test(err || '')
    for (const item of items) {
      const res = await applyOne(item, cfg)
      log.push({ lineId: item.lineId, invoiceNumber: item.invoiceNumber, amount: item.amount, ...res })
      // SF logged us out — this isn't a problem with the line, and nothing posted
      // (we fail before the payment). Leave the line 'approved' (don't record a
      // failure) so it retries after we sign back in, and stop the pass since the
      // rest would fail identically.
      if (!res.ok && isSfLogout(res.error)) {
        log.push({ stoppedEarly: 'SF session expired — lines left queued for retry after re-login' })
        break
      }
      // In dry-run we never write back (nothing is really posted). In live mode,
      // record both successes and failures so the app's audit log is accurate.
      if (!cfg.dryRun) {
        try {
          await postResult(cfg.baseUrl, cfg.token, {
            lineId: item.lineId, ok: res.ok, sfPaymentId: res.paymentId ?? null,
            sfResponse: { trace: res.trace }, error: res.ok ? undefined : res.error,
          })
        } catch (e) { log.push({ lineId: item.lineId, callbackError: String(e) }) }
      }
      res.ok ? applied++ : failed++
      await sleep(1500) // be gentle on SF
    }
    // Second pass: post any queued SF job notes (invoice-reminder audit trail,
    // etc.). Independent of the payment pass — a failure here never affects it.
    const notes = await runNotes(cfg, log)

    // Alert on SF trouble: a login-looking failure → logged_out; any other apply
    // failure → error. Deduped server-side so it's one email, not one per line.
    if (!cfg.dryRun) {
      const failures = log.filter(l => l.ok === false)
      const staleSf = failures.some(l => isSfLogout(l.error))
      if (staleSf) {
        setBadge('!')
        if (source === 'sf-recover') {
          // Already refreshed once and it still failed → genuinely needs a human.
          await notifyAlert('service_fusion', 'logged_out')
        } else {
          // Most often the SF session just needs a refresh — warm it and retry
          // silently. No email unless the retry also fails (above).
          await warmSfSession({ retry: true })
        }
      }
      else if (failures.length) { setBadge('!'); await notifyAlert('service_fusion', 'error', `${failures.length} remittance line(s) failed to post`) }
    }

    await setStatus({ source, dryRun: cfg.dryRun, queued: items.length, skipped: skipped ?? [], applied, failed, notes, log })
    console.log('[sf-remittance] run complete', { dryRun: cfg.dryRun, applied, failed, notes, log })
    return { ok: true, dryRun: cfg.dryRun, applied, failed, notes, log }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await setStatus({ source, error, log })
    console.error('[sf-remittance] run failed', error)
    return { ok: false, error }
  } finally {
    running = false
  }
}
