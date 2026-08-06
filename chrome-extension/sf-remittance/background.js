import { getConfig, setStatus } from './store.js'
import { fetchQueue, postResult } from './app-api.js'
import { applyOne } from './sf.js'

const ALARM = 'sf-remittance-poll'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function scheduleAlarm() {
  const { pollMinutes } = await getConfig()
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, Number(pollMinutes) || 10) })
}

chrome.runtime.onInstalled.addListener(scheduleAlarm)
chrome.runtime.onStartup.addListener(scheduleAlarm)
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) run('alarm') })

// Manual "Run now" from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'run-now') { run('manual').then(r => sendResponse(r)); return true }
})

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
    for (const item of items) {
      const res = await applyOne(item, cfg)
      log.push({ lineId: item.lineId, invoiceNumber: item.invoiceNumber, amount: item.amount, ...res })
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
    await setStatus({ source, dryRun: cfg.dryRun, queued: items.length, skipped: skipped ?? [], applied, failed, log })
    console.log('[sf-remittance] run complete', { dryRun: cfg.dryRun, applied, failed, log })
    return { ok: true, dryRun: cfg.dryRun, applied, failed, log }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await setStatus({ source, error, log })
    console.error('[sf-remittance] run failed', error)
    return { ok: false, error }
  } finally {
    running = false
  }
}
