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

chrome.runtime.onInstalled.addListener(() => { scheduleAlarm(); scheduleGenieCrawl() })
chrome.runtime.onStartup.addListener(() => { scheduleAlarm(); scheduleGenieCrawl() })
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM) run('alarm')
  else if (a.name === GENIE_ALARM) maybeScheduledCrawl()
  else if (a.name === GENIE_TIMEOUT_ALARM) onCrawlTimeout()
  else if (a.name === SF_RECOVER_ALARM) finishSfRecover()
})

// A scheduled crawl that never signalled done → it stalled. Close its tab and
// alert, so a silently-broken crawl doesn't go unnoticed.
async function onCrawlTimeout() {
  const { genieCrawl } = await chrome.storage.local.get('genieCrawl')
  await finishCrawl('timeout')
  if (genieCrawl) { setBadge('!'); await notifyAlert('genie', 'error', 'scheduled crawl did not finish (timed out)') }
}

// ── Scheduled Genie crawl ───────────────────────────────────────────────────
// An always-on office PC runs this: hourly during work hours (incremental — just
// new/changed orders) plus a nightly full backfill. The alarm fires hourly and
// the handler decides what (if anything) to run based on the PT clock. Each crawl
// opens a background tab to the order list; the content script does the work and
// signals completion, then we close the tab. A timeout alarm force-closes a tab
// that never finishes. State lives in chrome.storage (the MV3 worker is ephemeral).
const GENIE_ALARM = 'genie-crawl'
const GENIE_TIMEOUT_ALARM = 'genie-crawl-timeout'
const SF_RECOVER_ALARM = 'sf-session-recover'
const GENIE_LIST_URL = 'https://install.openings.net/webcenter/portal/installerconnect/orderlist'
const CRAWL_TZ = 'America/Los_Angeles'
const CRAWL_TIMEOUT_MS = 20 * 60 * 1000

// delayInMinutes:1 so the schedule also fires ~1 min after Chrome start / an
// extension reload — otherwise each reload restarts a full 60-min countdown and a
// machine that's reloaded/restarted often could go a long time without a crawl.
function scheduleGenieCrawl() { chrome.alarms.create(GENIE_ALARM, { delayInMinutes: 1, periodInMinutes: 60 }) }

function ptNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: CRAWL_TZ, weekday: 'short', hour: '2-digit', hour12: false })
      .formatToParts(new Date()).map(p => [p.type, p.value]))
  return { hour: Number(parts.hour) % 24, weekday: parts.weekday }
}

async function maybeScheduledCrawl() {
  const cfg = await getConfig()
  if (!cfg.genieScheduleEnabled) return
  const { hour, weekday } = ptNow()
  const workday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(weekday)
  let mode = null
  if (hour === 3) mode = 'full'                                   // nightly full backfill ~3am PT
  else if (workday && hour >= 7 && hour <= 18) mode = 'incremental' // 7am–6pm Mon–Sat
  if (!mode) return
  await startCrawl(mode)
}

async function tabExists(tabId) {
  if (tabId == null) return false
  try { await chrome.tabs.get(tabId); return true } catch { return false }
}

// mode: 'full' | 'incremental'. force:true (the manual button) always starts a
// fresh crawl. Returns { started, reason }.
async function startCrawl(mode, { force = false } = {}) {
  const { genieCrawl } = await chrome.storage.local.get('genieCrawl')
  // Only treat an existing crawl as "already running" if it's recent AND its tab
  // is actually still open. Stale state (tab closed / worker died / a missed
  // 'done' message) must not block a new crawl — especially the manual button.
  if (genieCrawl && !force && Date.now() - genieCrawl.startedAt < CRAWL_TIMEOUT_MS && await tabExists(genieCrawl.tabId)) {
    console.log('[genie] crawl already running')
    return { started: false, reason: 'already running' }
  }
  // Force, or leftover state — tear down anything stale before starting fresh.
  if (genieCrawl) {
    chrome.alarms.clear(GENIE_TIMEOUT_ALARM)
    if (genieCrawl.tabId != null) { try { await chrome.tabs.remove(genieCrawl.tabId) } catch { /* already closed */ } }
  }
  await chrome.storage.local.set({ genieCrawlMode: mode })
  const tab = await chrome.tabs.create({ url: GENIE_LIST_URL, active: false })
  await chrome.storage.local.set({ genieCrawl: { tabId: tab.id, mode, startedAt: Date.now() } })
  await setStatus({ source: 'genie-schedule', mode, state: 'running' })
  chrome.alarms.create(GENIE_TIMEOUT_ALARM, { when: Date.now() + CRAWL_TIMEOUT_MS })
  console.log('[genie] crawl started:', mode, force ? '(forced)' : '')
  return { started: true }
}

async function finishCrawl(reason) {
  const { genieCrawl } = await chrome.storage.local.get('genieCrawl')
  chrome.alarms.clear(GENIE_TIMEOUT_ALARM)
  await chrome.storage.local.remove(['genieCrawl', 'genieCrawlMode'])
  if (genieCrawl && genieCrawl.tabId != null && reason !== 'login') {
    try { await chrome.tabs.remove(genieCrawl.tabId) } catch { /* already closed */ }
  }
  console.log('[genie] crawl finished:', reason)
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

// ── Self-heal a logged-out Service Fusion session ────────────────────────────
// When posting fails because SF logged us out, open admin.servicefusion.com in a
// background tab. Logged-out SF 302s to its login page, where content-login.js
// signs in with the saved SF credentials — then we close the tab and retry the
// queued work. Fully unattended, provided SF credentials are saved in Options.
const SF_RECOVER_MS = 45000
async function recoverSfSession() {
  const cfg = await getConfig()
  if (!cfg.sfUser || !cfg.sfPass) return false // no saved creds → can't self-heal (alert already sent)
  const { sfRecovering } = await chrome.storage.local.get('sfRecovering')
  if (sfRecovering && Date.now() - sfRecovering.at < 3 * 60 * 1000) return true // already recovering
  const tab = await chrome.tabs.create({ url: 'https://admin.servicefusion.com/', active: false })
  await chrome.storage.local.set({ sfRecovering: { tabId: tab.id, at: Date.now() } })
  chrome.alarms.create(SF_RECOVER_ALARM, { when: Date.now() + SF_RECOVER_MS })
  console.log('[sf] session expired → opened login tab for unattended sign-in')
  return true
}

async function finishSfRecover() {
  const { sfRecovering } = await chrome.storage.local.get('sfRecovering')
  await chrome.storage.local.remove('sfRecovering')
  if (sfRecovering && sfRecovering.tabId != null) { try { await chrome.tabs.remove(sfRecovering.tabId) } catch { /* already closed */ } }
  console.log('[sf] recovery window elapsed → retrying queued work')
  run('sf-recover') // re-post now that we should be signed back in
}

// Manual "Run now" from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'run-now') { run('manual').then(r => sendResponse(r)); return true }
})

// "Full Genie crawl now" from the popup — same machinery as a scheduled full
// crawl (opens a background tab, details every order, closes when done), but on
// demand and regardless of the schedule/auto-detail toggles.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'genie-crawl-now') return
  ;(async () => {
    const cfg = await getConfig()
    if (!cfg.baseUrl || !cfg.token) { sendResponse({ ok: false, error: 'set Castle Admin URL + token in Options' }); return }
    setBadge('')
    // force:true — a manual click always opens a fresh crawl tab, even if stale
    // crawl state is lingering from a previous run.
    const r = await startCrawl('full', { force: true })
    sendResponse({ ok: !!r.started, error: r.started ? undefined : (r.reason || 'could not start') })
  })()
  return true
})

// content-genie.js asks whether it's running in the extension's crawl tab, so it
// only auto-navigates the portal there (never in the user's own browsing).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'genie-crawl-tab?') return
  ;(async () => {
    const { genieCrawl } = await chrome.storage.local.get('genieCrawl')
    sendResponse({ isCrawlTab: !!(genieCrawl && sender.tab && sender.tab.id === genieCrawl.tabId) })
  })()
  return true
})

// Content scripts signal a scheduled crawl's outcome.
chrome.runtime.onMessage.addListener((msg, sender, _sendResponse) => {
  if (msg?.type === 'genie-crawl-done') {
    ;(async () => {
      const { genieCrawl } = await chrome.storage.local.get('genieCrawl')
      // Only act on the crawl's own tab — a manual crawl in a user tab is ignored.
      if (genieCrawl && sender.tab && sender.tab.id === genieCrawl.tabId) { setBadge(''); await finishCrawl('done') }
    })()
    return
  }
  // A login page couldn't be signed into automatically (no saved credentials, or
  // they didn't take / MFA). Badge + email so someone signs in by hand.
  const LOGIN_ALERTS = {
    'genie-login-detected': 'genie',
    'sf-login-detected': 'service_fusion',
    'castle-login-detected': 'castle_admin',
  }
  if (msg?.type && LOGIN_ALERTS[msg.type]) {
    const source = LOGIN_ALERTS[msg.type]
    ;(async () => {
      await setStatus({ source: `${source}-login`, state: 'login_required' })
      setBadge('!')
      await notifyAlert(source, 'logged_out') // email chosen recipients (deduped server-side)
      if (msg.type === 'genie-login-detected') {
        const { genieCrawl } = await chrome.storage.local.get('genieCrawl')
        if (genieCrawl && sender.tab && sender.tab.id === genieCrawl.tabId) {
          try { await chrome.tabs.update(genieCrawl.tabId, { active: true }) } catch { /* ignore */ } // surface for one-click login
          await finishCrawl('login') // keep the tab open for re-auth
        }
      }
    })()
    return
  }
})

// Orders scraped from a vendor portal (content-genie.js) → Castle Admin ingest.
// Independent of the SF poll loop; posts in the user's session using the same
// base URL + token.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'genie') return
  ;(async () => {
    const cfg = await getConfig()
    if (cfg.genieEnabled === false) { sendResponse({ ok: false, error: 'genie disabled' }); return }
    if (!cfg.baseUrl || !cfg.token) { sendResponse({ ok: false, error: 'not configured' }); return }
    const orders = msg.kind === 'detail' ? [msg.payload] : (msg.payload || [])
    if (!orders.length) { sendResponse({ ok: true, skipped: 'no orders' }); return }
    try {
      const res = await postVendorOrders(cfg.baseUrl, cfg.token, msg.vendor, orders, { kind: msg.kind, mode: msg.mode })
      await setStatus({ source: 'genie', vendor: msg.vendor, kind: msg.kind, ingest: res })
      console.log('[sf-remittance] genie ingest', res)
      sendResponse({ ok: true, ...res })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error('[sf-remittance] genie ingest failed', error)
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
      const loggedOut = failures.some(l => /login\?true|session expired|redirected to login|got (?:a )?login|global search did not return json/i.test(l.error || ''))
      if (loggedOut) {
        setBadge('!')
        // Try to sign back in automatically; still alert so a human is looped in
        // if the auto-login can't take (no saved creds / MFA / changed form).
        const recovering = await recoverSfSession()
        await notifyAlert('service_fusion', 'logged_out', recovering ? 'auto sign-in attempted' : undefined)
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
