import { getConfig, setStatus } from './store.js'
import { fetchQueue, postResult, fetchNoteQueue, postNoteResult } from './app-api.js'
import { applyOne } from './sf.js'
import { postNote } from './sf-note.js'

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
    log.push({ noteId: item.id, event: item.event, jobId: item.sfJobId, ...res })
    if (!cfg.dryRun) {
      try {
        await postNoteResult(cfg.baseUrl, cfg.token, {
          id: item.id, ok: res.ok, sfResponse: { trace: res.trace, snippet: res.snippet }, error: res.ok ? undefined : res.error,
        })
      } catch (e) { log.push({ noteId: item.id, callbackError: String(e) }) }
    }
    res.ok ? posted++ : failed++
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
    // Second pass: post any queued SF job notes (invoice-reminder audit trail,
    // etc.). Independent of the payment pass — a failure here never affects it.
    const notes = await runNotes(cfg, log)

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
