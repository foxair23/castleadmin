import { getConfig, setStatus, pushHistory } from './store.js'
import { fetchQueue, postResult, fetchNoteQueue, postNoteResult, postVendorOrders, postAlert, fetchLinesQueue, postLinesResult, fetchScheduleQueue, postScheduleResult, fetchDocsQueue, postDocsResult } from './app-api.js'
import { applyOne } from './sf.js'
import { addLinesToJob } from './sf-lines.js'
import { setJobSchedule } from './sf-schedule.js'
import { uploadDocument } from './sf-document.js'
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
const SESSION_WARM_ALARM = 'session-warm'
const RUN_LOCK_MS = 15 * 60 * 1000
const CRAWL_HARD_CAP_MS = 4 * 60 * 60 * 1000
// Clopay's IAM login link with a baked-in OIDC state — the original entry point. Kept as
// the fallback the cca page navigates to when the app root neither shows a login form
// nor the dashboard.
export const CLOPAY_LEGACY_LOGIN_URL = 'https://prod-iam.clopay.com/Account/Login?ReturnUrl=%2Fconnect%2Fauthorize%2Fcallback%3Fresponse_type%3Dcode%26client_id%3D6f5a9fb9039d422abebe546ef935951b%26state%3DT2dVTzlsfkt4LWJwdDdyYm1tOGJIM1BFNWtmTnZCQ1pfaDFhUmJpLVV4MmlH%26redirect_uri%3Dhttps%253A%252F%252Fcca.clopay.com%252Fsignin-oidc%26scope%3Dopenid%2520profile%26code_challenge%3DFemCme6P6lp59gS8nDRLwOnnnyZgSAWtuHKdUlpHcf8%26code_challenge_method%3DS256%26nonce%3DT2dVTzlsfkt4LWJwdDdyYm1tOGJIM1BFNWtmTnZCQ1pfaDFhUmJpLVV4MmlH'

// ── Scheduled vendor-portal crawls (Genie + Clopay share one engine) ────────
// An always-on office machine runs these: hourly during work hours (incremental — just
// new/changed orders), a nightly full backfill, and for Clopay a nightly document sync.
// The alarm fires every 15 minutes and the handler decides what is DUE from stored
// stamps (last incremental finished, last full/docs date) — never from an hour
// equality, so a missed tick (sleep, restart, Chrome update) is caught up on the next
// one rather than skipped for the day.
//
// Each crawl opens a tab in its own minimized window (Chrome throttles timers in
// background tabs of a visible window once the screen locks); the content script does
// the work, reports PROGRESS as it goes, and signals completion with a reason. The
// watchdog is inactivity-based: as long as progress keeps arriving the crawl may run
// (up to a hard cap); a crawl that goes quiet is closed as 'stalled'. State lives in
// chrome.storage (the MV3 worker is ephemeral); progress is written there too, so a
// message lost while the worker slept still counts.
//
// Every crawler is one descriptor here — its portal URL, its own storage keys /
// alarm names, the option flags that gate it, and the login/alert source names.
const CRAWLERS = {
  genie: {
    name: 'genie', vendor: 'genie_thd',
    listUrl: () => 'https://install.openings.net/webcenter/portal/installerconnect/orderlist',
    inactivityMs: { default: 6 * 60 * 1000 },
    stateKey: 'genieCrawl', modeKey: 'genieCrawlMode', progressKey: 'genieCrawlProgress',
    alarm: 'genie-crawl', timeoutAlarm: 'genie-crawl-timeout',
    scheduleFlag: 'genieScheduleEnabled', enabledFlag: 'genieEnabled',
    loginFlag: 'genie-login-detected', alertSource: 'genie',
  },
  clopay: {
    name: 'clopay', vendor: 'clopay_hd',
    // Enter through the app root (cca.clopay.com), which starts its own OIDC flow with a
    // fresh state: content-login signs in on prod-iam, the flow returns to cca, and
    // content-clopay's cca handler clicks HD Program → hdprogram.clopay.com/orders.
    // The legacy hardcoded login link is the fallback the cca page falls through to.
    listUrl: (cfg) => (cfg && cfg.clopayEntryUrl) || 'https://cca.clopay.com/',
    inactivityMs: { default: 8 * 60 * 1000, docs: 15 * 60 * 1000 },
    stateKey: 'clopayCrawl', modeKey: 'clopayCrawlMode', progressKey: 'clopayCrawlProgress',
    alarm: 'clopay-crawl', timeoutAlarm: 'clopay-crawl-timeout',
    scheduleFlag: 'clopayScheduleEnabled', enabledFlag: 'clopayEnabled',
    loginFlag: 'clopay-login-detected', alertSource: 'clopay',
  },
}
const inactivityFor = (c, mode) => (c.inactivityMs[mode] || c.inactivityMs.default)
const crawlerByName = (name) => CRAWLERS[name] || null
const crawlerByLoginFlag = (flag) => Object.values(CRAWLERS).find(c => c.loginFlag === flag) || null
const crawlerByIngestType = (type) => CRAWLERS[type] || null // content scripts send type === crawler name

function armAll() { scheduleAlarm(); scheduleAllCrawls(); scheduleSfKeepalive(); scheduleSessionWarm() }
chrome.runtime.onInstalled.addListener(armAll)
chrome.runtime.onStartup.addListener(armAll)
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM) return run('alarm')
  if (a.name === SF_RECOVER_ALARM) return finishSfRecover()
  if (a.name === SF_KEEPALIVE_ALARM) return maybeSfKeepalive()
  if (a.name === SESSION_WARM_ALARM) return maybeWarmSessions()
  for (const c of Object.values(CRAWLERS)) {
    if (a.name === c.alarm) return maybeScheduledCrawl(c)
    if (a.name === c.timeoutAlarm) return onCrawlTimeout(c)
  }
})

// The watchdog fired: nothing has been heard from the crawl for its inactivity window.
// Progress is also written to storage by the content script — a message that arrived
// while the worker slept still counts — so re-read that first. Fresh progress → give it
// another window. Silence → close it as stalled (a run row / badge, never an email: the
// app's health check is what decides whether a stalled crawl matters).
async function onCrawlTimeout(c) {
  const st = await chrome.storage.local.get([c.stateKey, c.progressKey])
  const state = st[c.stateKey]
  if (!state) return
  const progress = st[c.progressKey]
  const lastAt = Math.max(state.lastProgressAt || state.startedAt || 0, (progress && progress.at) || 0)
  const window_ = inactivityFor(c, state.mode)
  if (Date.now() - lastAt < window_ && Date.now() < (state.hardCapAt || 0)) {
    chrome.alarms.create(c.timeoutAlarm, { when: lastAt + window_ })
    return
  }
  await finishCrawl(c, Date.now() >= (state.hardCapAt || 0) ? 'hard-cap' : 'stalled', progress ? { phase: progress.phase, done: progress.done, total: progress.total } : {})
}

// Every 15 minutes; delayInMinutes:1 so the schedule also fires ~1 min after Chrome
// start / an extension reload and catches up on anything that is due.
function scheduleAllCrawls() { for (const c of Object.values(CRAWLERS)) chrome.alarms.create(c.alarm, { delayInMinutes: 1, periodInMinutes: 15 }) }
function scheduleSfKeepalive() { chrome.alarms.create(SF_KEEPALIVE_ALARM, { delayInMinutes: 2, periodInMinutes: 60 }) }
function scheduleSessionWarm() { chrome.alarms.create(SESSION_WARM_ALARM, { delayInMinutes: 30, periodInMinutes: 60 }) }

function ptNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: CRAWL_TZ, weekday: 'short', hour: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map(p => [p.type, p.value]))
  return { hour: Number(parts.hour) % 24, weekday: parts.weekday, date: `${parts.year}-${parts.month}-${parts.day}` }
}

// What each crawler last finished, for the due-check. PT dates for the daily jobs, a
// timestamp for the hourly one.
async function getStamps(c) { return ((await chrome.storage.local.get('crawlStamps')).crawlStamps || {})[c.name] || {} }
async function setStamp(c, patch) {
  const all = (await chrome.storage.local.get('crawlStamps')).crawlStamps || {}
  all[c.name] = { ...(all[c.name] || {}), ...patch }
  await chrome.storage.local.set({ crawlStamps: all })
}

/** Is a crawl running with fresh progress? (A stale one is torn down by startCrawl.) */
async function crawlActive(c) {
  const st = await chrome.storage.local.get([c.stateKey, c.progressKey])
  const state = st[c.stateKey]
  if (!state) return false
  const lastAt = Math.max(state.lastProgressAt || state.startedAt || 0, (st[c.progressKey] && st[c.progressKey].at) || 0)
  return Date.now() - lastAt < inactivityFor(c, state.mode) && await tabExists(state.tabId)
}

// Decide what is due. Priority: docs (Clopay, 2–5am, once a day) > full (3–6am, once a
// day; a full that ended on its time budget is NOT stamped done, so it resumes on the
// next tick until it finishes or the window closes) > incremental (Mon–Sat 7am–6pm, when
// the last one finished more than 50 minutes ago).
async function maybeScheduledCrawl(c) {
  const cfg = await getConfig()
  if (await crawlActive(c)) return
  const { hour, weekday, date } = ptNow()
  const stamps = await getStamps(c)
  const workday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(weekday)
  if (c.name === 'clopay' && cfg.clopayDocSyncEnabled && hour >= 2 && hour <= 5 && stamps.lastDocsDoneDate !== date) { await startCrawl(c, 'docs'); return }
  if (!cfg[c.scheduleFlag]) return
  if (hour >= 3 && hour <= 6 && stamps.lastFullDoneDate !== date) { await startCrawl(c, 'full'); return }
  if (workday && hour >= 7 && hour <= 18 && Date.now() - (stamps.lastIncrementalDoneAt || 0) > 50 * 60 * 1000) { await startCrawl(c, 'incremental'); return }
}

// Keep every portal session alive: once an hour, at a quiet moment, open each portal in
// 'warm' mode (reach a logged-in page, then close). If the session had expired the login
// happens HERE — proactively — rather than in the middle of a crawl. Skipped when the
// portal was crawled or warmed in the last 50 minutes.
async function maybeWarmSessions() {
  const cfg = await getConfig()
  for (const c of Object.values(CRAWLERS)) {
    if (cfg[c.enabledFlag] === false || !cfg[c.scheduleFlag]) continue
    if (await crawlActive(c)) continue
    const stamps = await getStamps(c)
    if (Date.now() - (stamps.lastTouchedAt || 0) < 50 * 60 * 1000) continue
    await startCrawl(c, 'warm')
    await sleep(2000)
  }
}

async function tabExists(tabId) {
  if (tabId == null) return false
  try { await chrome.tabs.get(tabId); return true } catch { return false }
}

// mode: 'full' | 'incremental' | 'docs' | 'warm'. force:true (the manual buttons) always
// starts a fresh crawl. Returns { started, reason }.
async function startCrawl(c, mode, { force = false } = {}) {
  const cfg = await getConfig()
  const state = (await chrome.storage.local.get(c.stateKey))[c.stateKey]
  if (state && !force && await crawlActive(c)) {
    console.log(`[${c.name}] crawl already running`)
    return { started: false, reason: 'already running' }
  }
  // Force, or leftover state — tear down anything stale before starting fresh.
  if (state) await teardownCrawlTab(c, state)
  await chrome.storage.local.set({ [c.modeKey]: mode })
  await chrome.storage.local.remove(c.progressKey)
  // A window of its own, minimized: a background TAB in the user's window gets its timers
  // throttled hard once the screen locks; a separate window does not.
  let tabId = null, windowId = null
  try {
    const win = await chrome.windows.create({ url: c.listUrl(cfg), focused: false, state: 'minimized', type: 'normal' })
    windowId = win.id; tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null
    if (tabId == null) { const tabs = await chrome.tabs.query({ windowId }); tabId = tabs[0] && tabs[0].id }
  } catch (e) {
    console.warn(`[${c.name}] minimized window failed (${e && e.message}) — falling back to a background tab`)
    const tab = await chrome.tabs.create({ url: c.listUrl(cfg), active: false })
    tabId = tab.id
  }
  const now = Date.now()
  await chrome.storage.local.set({ [c.stateKey]: { tabId, windowId, mode, startedAt: now, lastProgressAt: now, hardCapAt: now + (mode === 'warm' ? 5 * 60 * 1000 : CRAWL_HARD_CAP_MS) } })
  await setStamp(c, { lastTouchedAt: now })
  await setStatus({ source: `${c.name}-schedule`, mode, state: 'running' })
  chrome.alarms.create(c.timeoutAlarm, { when: now + (mode === 'warm' ? 3 * 60 * 1000 : inactivityFor(c, mode)) })
  console.log(`[${c.name}] crawl started:`, mode, force ? '(forced)' : '')
  return { started: true }
}

async function teardownCrawlTab(c, state) {
  chrome.alarms.clear(c.timeoutAlarm)
  if (state && state.windowId != null) { try { await chrome.windows.remove(state.windowId) } catch { /* already closed */ } }
  else if (state && state.tabId != null) { try { await chrome.tabs.remove(state.tabId) } catch { /* already closed */ } }
}

// A crawl reached a terminal state. `reason` is what the content script (or the
// watchdog) said; `counts` whatever it measured. Stamps the schedule, keeps the
// history, sets/clears the badge problem, closes the window (kept open on 'login' so a
// person can sign in by hand if they are at the machine).
const GOOD_REASONS = new Set(['done', 'warm-ok', 'budget'])
async function finishCrawl(c, reason, counts = {}) {
  const st = await chrome.storage.local.get([c.stateKey, c.progressKey])
  const state = st[c.stateKey]
  chrome.alarms.clear(c.timeoutAlarm)
  await chrome.storage.local.remove([c.stateKey, c.modeKey, c.progressKey])
  if (reason !== 'login') await teardownCrawlTab(c, state)
  // The Clopay doc-sync uses a hidden debugger-driven capture tab — detach + close it.
  if (c.name === 'clopay') { try { await teardownCaptureDebugger() } catch { /* ignore */ } }
  const mode = state ? state.mode : null
  const now = Date.now()
  const stamp = { lastTouchedAt: now }
  if (reason === 'done') {
    if (mode === 'docs') stamp.lastDocsDoneDate = ptNow().date
    else if (mode === 'full') { stamp.lastFullDoneDate = ptNow().date; stamp.lastIncrementalDoneAt = now }
    else if (mode === 'incremental') stamp.lastIncrementalDoneAt = now
  } else if (reason === 'budget' && mode === 'incremental') stamp.lastIncrementalDoneAt = now
  await setStamp(c, stamp)
  if (GOOD_REASONS.has(reason)) await clearProblem(`crawl:${c.name}`, `login:${c.name}`)
  else if (mode !== 'warm' || reason === 'login') await setProblem(`crawl:${c.name}`, reason)
  const entry = { kind: mode === 'warm' ? 'warm' : 'crawl', site: c.name, mode, reason, ok: GOOD_REASONS.has(reason), startedAt: state ? state.startedAt : null, finishedAt: now, ms: state ? now - state.startedAt : null, counts }
  await pushHistory(entry)
  await setStatus({ source: `${c.name}-schedule`, mode, state: reason, counts })
  console.log(`[${c.name}] crawl finished:`, reason, counts)
  return entry
}

// ── Badge: '!' while any problem is open, cleared when its cause succeeds ──────
async function setProblem(key, detail) {
  const { problems = {} } = await chrome.storage.local.get('problems')
  problems[key] = { at: Date.now(), detail: detail || null }
  await chrome.storage.local.set({ problems })
  await refreshBadge()
}
async function clearProblem(...keys) {
  const { problems = {} } = await chrome.storage.local.get('problems')
  let changed = false
  for (const k of keys) if (problems[k]) { delete problems[k]; changed = true }
  if (changed) await chrome.storage.local.set({ problems })
  await refreshBadge()
}
async function clearAllProblems() { await chrome.storage.local.set({ problems: {} }); await refreshBadge() }
async function refreshBadge() {
  const { problems = {} } = await chrome.storage.local.get('problems')
  setBadge(Object.keys(problems).length ? '!' : '')
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
    await clearProblem(`crawl:${c.name}`)
    // force:true — a manual click always opens a fresh crawl tab, even if stale
    // crawl state is lingering from a previous run.
    const r = await startCrawl(c, 'full', { force: true })
    sendResponse({ ok: !!r.started, error: r.started ? undefined : (r.reason || 'could not start') })
  })()
  return true
})

// "Sync Clopay documents now" from the popup — opens the authenticated orders tab in
// document-sync mode (mode 'docs'); the content script lists orders and captures each
// document's file into Castle via the injected-session debugger helper tab. Separate,
// slower, and resumable (dedup skips stored docs) — kept off the fast list/notes crawl.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'clopay-docsync-now') return
  ;(async () => {
    const cfg = await getConfig()
    if (!cfg.baseUrl || !cfg.token) { sendResponse({ ok: false, error: 'set Castle Admin URL + token in Options' }); return }
    await clearProblem('crawl:clopay')
    const r = await startCrawl(CRAWLERS.clopay, 'docs', { force: true })
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

// Content scripts report PROGRESS ('genie-crawl-progress', …) and the OUTCOME
// ('genie-crawl-done' with a reason and counts). Progress re-arms the inactivity
// watchdog; the content script also writes it to storage, which onCrawlTimeout reads.
chrome.runtime.onMessage.addListener((msg, sender, _sendResponse) => {
  const prog = typeof msg?.type === 'string' && msg.type.endsWith('-crawl-progress') ? crawlerByName(msg.type.slice(0, -'-crawl-progress'.length)) : null
  if (prog) {
    ;(async () => {
      const state = (await chrome.storage.local.get(prog.stateKey))[prog.stateKey]
      if (!state || !sender.tab || sender.tab.id !== state.tabId) return
      const now = Date.now()
      await chrome.storage.local.set({ [prog.stateKey]: { ...state, lastProgressAt: now, progress: { phase: msg.phase, done: msg.done, total: msg.total } } })
      chrome.alarms.create(prog.timeoutAlarm, { when: Math.min(now + inactivityFor(prog, state.mode), state.hardCapAt || Infinity) })
    })()
    return
  }
  const done = typeof msg?.type === 'string' && msg.type.endsWith('-crawl-done') ? crawlerByName(msg.type.slice(0, -'-crawl-done'.length)) : null
  if (done) {
    ;(async () => {
      const state = (await chrome.storage.local.get(done.stateKey))[done.stateKey]
      // Only act on the crawl's own tab — a manual crawl in a user tab is ignored.
      if (!state || !sender.tab || sender.tab.id !== state.tabId) return
      const reason = msg.reason || 'done'
      // Not signed in: that is a login problem, handled by the login-failure path below
      // (fresh-tab retry, then one alert) rather than a silent end.
      if (reason === 'no-token' || reason === 'unauthorized') { await onLoginFailure(done, sender.tab.id, reason, sender.url); return }
      await finishCrawl(done, reason, msg.counts || {})
    })()
    return
  }
  // The login content script could not sign in ('<site>-login-detected' with a reason),
  // or did ('<site>-login-ok').
  const LOGIN_SITES = {
    'genie-login-detected': 'genie', 'clopay-login-detected': 'clopay',
    'sf-login-detected': 'service_fusion', 'castle-login-detected': 'castle_admin',
  }
  if (msg?.type && LOGIN_SITES[msg.type]) {
    const source = LOGIN_SITES[msg.type]
    const c = crawlerByLoginFlag(msg.type)
    ;(async () => {
      if (c) { await onLoginFailure(c, sender.tab ? sender.tab.id : null, msg.reason || 'unknown', msg.url); return }
      // SF / Castle Admin: no crawl to retry — badge + one alert with the reason.
      await setStatus({ source: `${source}-login`, state: 'login_required', reason: msg.reason })
      await setProblem(`login:${source}`, msg.reason)
      await pushHistory({ kind: 'login', site: source, ok: false, reason: msg.reason, finishedAt: Date.now() })
      await notifyAlert(source, 'logged_out', `auto-login failed: ${msg.reason || 'unknown'}`)
    })()
    return
  }
  if (typeof msg?.type === 'string' && msg.type.endsWith('-login-ok')) {
    const site = msg.type.slice(0, -'-login-ok'.length)
    ;(async () => {
      const key = site === 'sf' ? 'service_fusion' : site === 'castle' ? 'castle_admin' : site
      const { loginRetry = {} } = await chrome.storage.local.get('loginRetry')
      delete loginRetry[key]
      await chrome.storage.local.set({ loginRetry })
      await clearProblem(`login:${key}`)
      await pushHistory({ kind: 'login', site: key, ok: true, finishedAt: Date.now() })
    })()
    return
  }
})

// Unattended login did not take. The first time, the tab itself is the usual culprit
// (a stale OIDC state, a form whose handler was not bound yet, the per-tab guard): close
// it and start over in a FRESH tab, once. If that also fails, end the crawl, badge, and
// send the ONE email that says what actually happened.
async function onLoginFailure(c, tabId, reason, url) {
  const state = (await chrome.storage.local.get(c.stateKey))[c.stateKey]
  if (!state || tabId == null || tabId !== state.tabId) return // not our tab: a user's own browsing
  const { loginRetry = {} } = await chrome.storage.local.get('loginRetry')
  const tries = (loginRetry[c.name] || 0) + 1
  loginRetry[c.name] = tries
  await chrome.storage.local.set({ loginRetry })
  await pushHistory({ kind: 'login', site: c.name, ok: false, reason, attempt: tries, url: url || null, finishedAt: Date.now() })
  if (tries < 2) {
    console.log(`[${c.name}] login failed (${reason}) — retrying once in a fresh tab`)
    const mode = state.mode
    await teardownCrawlTab(c, state)
    await chrome.storage.local.remove([c.stateKey, c.progressKey])
    await startCrawl(c, mode, { force: true })
    return
  }
  delete loginRetry[c.name]
  await chrome.storage.local.set({ loginRetry })
  await setStatus({ source: `${c.name}-login`, state: 'login_required', reason })
  await setProblem(`login:${c.name}`, reason)
  await finishCrawl(c, 'login', { reason })
  await notifyAlert(c.alertSource, 'logged_out', `auto-login failed twice: ${reason}`)
}

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
async function storeClopayDoc({ external_id, documentId, filename, mime, dataB64, docType, rawName }) {
  const cfg = await getConfig()
  if (!cfg.baseUrl || !cfg.token) return { ok: false, error: 'not configured' }
  if (!external_id || documentId == null) return { ok: false, error: 'bad args' }
  try {
    const res = await fetch(`${cfg.baseUrl}/api/vendor-orders/attachment/store`, {
      method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'clopay_hd', external_id, documentId, filename, mime, docType: docType || null, rawName: rawName || null, ...(dataB64 ? { dataB64 } : {}) }),
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

// ── Clopay document capture (page grant + REAL top-level tab navigation) ──────
// This mirrors the app's own document-open flow 1:1 — the only combination not yet
// disproven (every other one is): the CONTENT SCRIPT calls getdocumenturl from the page
// context (the grant is bound to the page origin), then we open the returned
// /showdocument URL as a genuine TOP-LEVEL NAVIGATION in a hidden capture tab — sending
// `Sec-Fetch-Dest: document`, which iframes (`dest: iframe` → served the Angular shell,
// v0.8.4–0.8.6) and fetches (`mode: cors` → shell, v0.7.x) never do. Session cookies are
// browser-wide, so the capture tab's navigation is cookie-authenticated.
//
// The Fetch domain is scoped to `*/showdocument/*` at the Response stage: reading the body
// there gets the full bytes BEFORE Chrome hands them to its PDF plugin, then the request
// is aborted (nothing renders). One hidden tab is reused for the whole sync.
const CAPTURE_PATTERN = '*://hdprogram.clopay.com/showdocument/*'
let captureTabId = null            // the hidden capture tab
let captureAttached = false
let pendingCapture = null          // { url, resolve } — capture is serial, so at most one

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
function headerValue(headers, name) {
  for (const h of (headers || [])) if (h && typeof h.name === 'string' && h.name.toLowerCase() === name) return h.value
  return ''
}
const isFileMime = (ct) => ct === 'application/pdf' || /^image\/(jpeg|jpg|png|heic|heif|webp)$/.test(ct)
const urlBase = (u) => (u || '').split('?')[0]

// CDP router: on the paused showdocument RESPONSE for the doc we're waiting on, read its
// body and abort the request; other showdocument requests just continue.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (captureTabId == null || source.tabId !== captureTabId || method !== 'Fetch.requestPaused') return
  const reqId = params.requestId
  const url = params.request && params.request.url
  const p = pendingCapture
  ;(async () => {
    if (p && url && urlBase(url) === urlBase(p.url)) {
      pendingCapture = null
      const ct = (headerValue(params.responseHeaders, 'content-type') || '').split(';')[0].trim().toLowerCase()
      const status = params.responseStatusCode || 0
      try {
        if (!isFileMime(ct)) {
          // Dump the response headers — they say WHO served the shell (cache/SW/server).
          console.log('[clopay] capture: not a file —', status, ct, url, JSON.stringify(params.responseHeaders || []))
          try { await dbgSend({ tabId: captureTabId }, 'Fetch.failRequest', { requestId: reqId, errorReason: 'Aborted' }) } catch { /* ignore */ }
          p.resolve({ ok: false, error: `not a file (${status}, ${ct || '?'})` }); return
        }
        const body = await dbgSend({ tabId: captureTabId }, 'Fetch.getResponseBody', { requestId: reqId })
        try { await dbgSend({ tabId: captureTabId }, 'Fetch.failRequest', { requestId: reqId, errorReason: 'Aborted' }) } catch { /* ignore */ }
        const b64 = body && body.base64Encoded ? body.body : null
        console.log('[clopay] capture: body', ct, b64 ? `${b64.length} b64 chars` : 'EMPTY/not-base64')
        p.resolve({ ok: true, mime: ct, base64: b64 })
      } catch (e) {
        try { await dbgSend({ tabId: captureTabId }, 'Fetch.failRequest', { requestId: reqId, errorReason: 'Aborted' }) } catch { /* ignore */ }
        p.resolve({ ok: false, error: 'getResponseBody ' + (e instanceof Error ? e.message : String(e)) })
      }
    } else {
      try { await dbgSend({ tabId: captureTabId }, 'Fetch.continueRequest', { requestId: reqId }) } catch { /* ignore */ }
    }
  })()
})
chrome.debugger.onDetach.addListener((source) => { if (source.tabId === captureTabId) { captureAttached = false; captureTabId = null } })

// Lazily create the hidden capture tab and attach the debugger, scoping Fetch
// interception to the document URL only (nothing else in that tab is touched).
async function ensureCaptureTab() {
  if (captureTabId != null && captureAttached && await tabExists(captureTabId)) return
  await teardownCaptureDebugger()
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false })
  captureTabId = tab.id
  await dbgAttach({ tabId: captureTabId })
  captureAttached = true
  await dbgSend({ tabId: captureTabId }, 'Fetch.enable', { patterns: [{ urlPattern: CAPTURE_PATTERN, requestStage: 'Response' }] })
}

async function teardownCaptureDebugger() {
  const id = captureTabId
  captureTabId = null; captureAttached = false
  if (pendingCapture) { try { pendingCapture.resolve({ ok: false, error: 'torn down' }) } catch { /* ignore */ } pendingCapture = null }
  if (id == null) return
  try { await new Promise(r => chrome.debugger.detach({ tabId: id }, () => { void chrome.runtime.lastError; r() })) } catch { /* ignore */ }
  try { await chrome.tabs.remove(id) } catch { /* already closed */ }
}

// Capture ONE document's bytes: navigate the hidden capture tab to its showdocument URL —
// a genuine top-level navigation (Sec-Fetch-Dest: document, cookies attached) — and read
// the intercepted PDF/image body before aborting the request.
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
    if (pendingCapture && pendingCapture.url === url) pendingCapture = null
    clearTimeout(timer)
    return { ok: false, error: 'navigate ' + (e instanceof Error ? e.message : String(e)) }
  }
  const res = await done
  clearTimeout(timer)
  return res
}

// Capture + store a batch of an order's documents. The content script (in the
// authenticated orders tab) resolves each showdocument URL via a PAGE-CONTEXT
// getdocumenturl call — the grant — then we navigate the hidden tab to each URL.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'clopay-capture-docs') return
  ;(async () => {
    const docs = Array.isArray(msg.docs) ? msg.docs : []
    const results = []
    for (const d of docs) {
      if (!d || !d.url || d.documentId == null || !d.external_id) { results.push({ documentId: d && d.documentId, ok: false, error: 'bad args' }); continue }
      const cap = await captureDocBytes(d.url)
      if (!cap.ok || !cap.base64) { results.push({ documentId: d.documentId, ok: false, error: cap.error || 'capture failed' }); continue }
      const store = await storeClopayDoc({ external_id: d.external_id, documentId: d.documentId, filename: d.filename, mime: cap.mime || 'application/pdf', dataB64: cap.base64, docType: d.docType, rawName: d.rawName })
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const c = crawlerByIngestType(msg?.type)
  if (!c) return
  ;(async () => {
    const cfg = await getConfig()
    if (cfg[c.enabledFlag] === false) { sendResponse({ ok: false, error: `${c.name} disabled` }); return }
    if (!cfg.baseUrl || !cfg.token) { sendResponse({ ok: false, error: 'not configured' }); return }
    const orders = msg.kind === 'detail' ? [msg.payload] : (msg.payload || [])
    if (!orders.length) { sendResponse({ ok: true, skipped: 'no orders' }); return }
    // While a scheduled crawl runs, only ITS tab's top frame may ingest: the content
    // script also runs in other frames/tabs of the portal and was posting the list two
    // or three times an hour.
    const state = (await chrome.storage.local.get(c.stateKey))[c.stateKey]
    if (state && sender.tab && (sender.tab.id !== state.tabId || (sender.frameId || 0) !== 0)) { sendResponse({ ok: true, skipped: 'not the crawl tab' }); return }
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

/** Put queued Clopay IPO line items on their SF jobs.
 *
 *  addLinesToJob refuses any job that already carries service lines, so this can never
 *  compete with hand-entered work. In dry-run nothing is posted and nothing is reported
 *  back — the trace shows what WOULD have been sent. */
async function runJobLines(cfg, log) {
  let posted = 0, failed = 0
  let items = []
  try {
    ({ items } = await fetchLinesQueue(cfg.baseUrl, cfg.token))
  } catch (e) {
    log.push({ linesQueueError: String(e) })
    return { posted, failed }
  }
  if (!items.length) return { posted, failed }
  console.log('[sf-remittance] job lines queue', { items: items.length })

  for (const item of items) {
    let res
    try {
      res = await addLinesToJob({ jobNumber: item.jobNumber, lines: item.lines, dryRun: cfg.dryRun })
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.push({ orderId: item.orderId, jobNumber: item.jobNumber, lines: item.lines.length, ...res })

    // A skip is a decision, not a failure: the job already has lines and we left it alone.
    // Report it so the order stops being re-queued every run.
    if (!cfg.dryRun) {
      try {
        await postLinesResult(cfg.baseUrl, cfg.token, {
          orderId: item.orderId,
          ok: !!res.ok,
          posted: res.posted ?? 0,
          error: res.ok ? undefined : (res.reason ?? res.error),
        })
      } catch (e) { log.push({ orderId: item.orderId, callbackError: String(e) }) }
    }
    res.ok ? posted++ : failed++
    await sleep(1500) // be gentle on SF
  }
  return { posted, failed }
}

/** Write queued Genie appointments onto their SF jobs — date and arrival window, through
 *  the job view page's inline editors; the status is left for the dispatcher. Same shape as
 *  runJobLines. */
async function runJobSchedule(cfg, log) {
  let posted = 0, failed = 0
  let items = []
  try {
    ({ items } = await fetchScheduleQueue(cfg.baseUrl, cfg.token))
  } catch (e) {
    log.push({ scheduleQueueError: String(e) })
    return { posted, failed }
  }
  if (!items.length) return { posted, failed }
  console.log('[sf-remittance] job schedule queue', { items: items.length })

  for (const item of items) {
    let res
    try {
      res = await setJobSchedule({ jobNumber: item.jobNumber, date: item.date, windowStart: item.windowStart, windowEnd: item.windowEnd, dryRun: cfg.dryRun })
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    // The writer reports the window it used as { start, end }; the log wants one string.
    const { window: w, ...rest } = res || {}
    const windowText = w ? `${w.start}-${w.end}${item.windowStart ? '' : ' (default)'}` : (item.windowStart ? `${item.windowStart}-${item.windowEnd}` : null)
    log.push({ orderId: item.orderId, jobNumber: item.jobNumber, date: item.date, window: windowText, ...rest })

    if (!cfg.dryRun) {
      try {
        await postScheduleResult(cfg.baseUrl, cfg.token, { orderId: item.orderId, ok: !!res.ok, error: res.ok ? undefined : (res.reason ?? res.error) })
      } catch (e) { log.push({ orderId: item.orderId, callbackError: String(e) }) }
    }
    res.ok ? posted++ : failed++
    await sleep(1500) // be gentle on SF
  }
  return { posted, failed }
}

/** Signed e-sign forms onto their SF jobs. DISCOVERY ONLY until SF's upload request is
 *  captured: each queued item gets its job page read and the upload widget's configuration
 *  reported back; nothing is uploaded and nothing counts as a failure. Items already
 *  discovered are skipped, so this costs one page read per document, once. */
async function runDocumentUploads(cfg, log) {
  let discovered = 0, posted = 0, failed = 0
  let items = []
  try {
    ({ items } = await fetchDocsQueue(cfg.baseUrl, cfg.token))
  } catch (e) {
    log.push({ docsQueueError: String(e) })
    return { discovered, posted, failed }
  }
  const todo = items.filter(i => !i.discovered)
  if (!todo.length) return { discovered, posted, failed, pending: items.length }
  console.log('[sf-remittance] document queue', { items: items.length, toDiscover: todo.length })
  for (const item of todo) {
    let res
    try {
      res = await uploadDocument({ jobNumber: item.jobNumber, dryRun: cfg.dryRun })
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    log.push({ docId: item.id, jobNumber: item.jobNumber, filename: item.filename, ...(res.discovery ? { discovery: { url: res.discovery.pluploadUrl, fileField: res.discovery.fileDataName, forms: res.discovery.forms?.length ?? 0 } } : {}), ...(res.error ? { error: res.error } : {}), discoveryOnly: res.ok === undefined })
    if (!cfg.dryRun) {
      try {
        if (res.ok === undefined) await postDocsResult(cfg.baseUrl, cfg.token, { id: item.id, discovery: res.discovery })
        else await postDocsResult(cfg.baseUrl, cfg.token, { id: item.id, ok: !!res.ok, error: res.ok ? undefined : res.error })
      } catch (e) { log.push({ docId: item.id, callbackError: String(e) }) }
    }
    if (res.ok === undefined) discovered++; else if (res.ok) posted++; else failed++
    await sleep(1500)
  }
  return { discovered, posted, failed, pending: items.length }
}

export async function run(source) {
  if (running) return { ok: false, error: 'already running' }
  // The in-memory flag dies with the worker; a storage lock stops a second run from
  // starting on top of one the worker was evicted from.
  const { runLock } = await chrome.storage.local.get('runLock')
  if (runLock && Date.now() - runLock.at < RUN_LOCK_MS && source !== 'manual') return { ok: false, error: 'a run is already in progress' }
  await chrome.storage.local.set({ runLock: { at: Date.now(), source } })
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
    // Second pass: put queued Clopay IPO line items on their SF jobs. Independent of the
    // payment pass — a failure here never affects it, and vice versa.
    const lines = await runJobLines(cfg, log)

    // Genie appointments onto their SF jobs — same wall, same arm. Independent of the rest.
    const schedule = await runJobSchedule(cfg, log)

    // Third pass: post any queued SF job notes (invoice-reminder audit trail,
    // etc.). Independent of the payment pass — a failure here never affects it.
    const notes = await runNotes(cfg, log)

    // Signed e-sign forms onto their SF jobs — discovery only until the upload request is captured.
    const docs = await runDocumentUploads(cfg, log)

    // SF session trouble: a login-looking failure → warm the session and retry once,
    // silently; only if the retry also fails is it a real logged-out alert. Per-item
    // failures are NOT emailed — each is already recorded by its callback and shown in
    // the app; the app's health check decides when a backlog matters.
    let staleSf = false
    if (!cfg.dryRun) {
      const failures = log.filter(l => l.ok === false)
      staleSf = failures.some(l => isSfLogout(l.error))
      if (staleSf) {
        if (source === 'sf-recover') {
          await setProblem('sf:logout', 'session expired and a refresh did not fix it')
          await notifyAlert('service_fusion', 'logged_out', 'SF session expired; the automatic refresh did not bring it back')
        } else {
          await warmSfSession({ retry: true })
        }
      } else {
        await clearProblem('sf:logout')
      }
    }

    await pushHistory({ kind: 'run', source, ok: !staleSf, dryRun: cfg.dryRun, queued: items.length, applied, failed, lines, schedule, notes, docs, finishedAt: Date.now() })
    await setStatus({ source, dryRun: cfg.dryRun, queued: items.length, skipped: skipped ?? [], applied, failed, lines, schedule, notes, docs, log })
    console.log('[sf-remittance] run complete', { dryRun: cfg.dryRun, applied, failed, lines, schedule, notes, docs, log })
    return { ok: true, dryRun: cfg.dryRun, applied, failed, lines, schedule, notes, docs, log }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await pushHistory({ kind: 'run', source, ok: false, error, finishedAt: Date.now() })
    await setStatus({ source, error, log })
    console.error('[sf-remittance] run failed', error)
    return { ok: false, error }
  } finally {
    running = false
    await chrome.storage.local.remove('runLock')
  }
}
