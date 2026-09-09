import { getConfig, getStatus } from './store.js'

function fmt(ts) { return ts ? new Date(ts).toLocaleString() : '—' }

async function render() {
  const cfg = await getConfig()
  const pills = document.getElementById('pills')
  pills.innerHTML =
    `<span class="pill ${cfg.enabled ? 'on' : 'off'}">${cfg.enabled ? 'Auto-poll ON' : 'Auto-poll OFF'}</span> ` +
    `<span class="pill ${cfg.dryRun ? 'dry' : 'on'}">${cfg.dryRun ? 'Dry run' : 'LIVE'}</span>`

  const s = await getStatus()
  const el = document.getElementById('status')
  if (!s) { el.textContent = 'No runs yet.'; return }
  const skipped = Array.isArray(s.skipped) ? s.skipped : []
  const n = s.notes || {}
  const notesLine = (n.queued ?? 0) ? `\nnotes ${n.queued} · posted ${n.posted ?? 0} · failed ${n.failed ?? 0}` : ''
  // The two job passes that go through SF's web session: IPO line items, Genie appointments.
  const li = s.lines || {}
  const linesLine = (li.posted || li.failed) ? `\nline items · posted ${li.posted ?? 0} · failed ${li.failed ?? 0}` : ''
  const sc = s.schedule || {}
  const schedLine = (sc.posted || sc.failed) ? `\nappointments · posted ${sc.posted ?? 0} · failed ${sc.failed ?? 0}` : ''
  const dc = s.docs || {}
  const docsLine = (dc.discovered || dc.posted || dc.failed || dc.pending) ? `\nsigned forms · ${dc.pending ?? 0} queued · discovered ${dc.discovered ?? 0} · uploaded ${dc.posted ?? 0} · failed ${dc.failed ?? 0}` : ''
  const head = s.error
    ? `Error: ${s.error}`
    : `Last run: ${fmt(s.at)}\nqueued ${s.queued ?? 0} · applied ${s.applied ?? 0} · failed ${s.failed ?? 0} · skipped ${skipped.length}${s.dryRun ? ' (dry run)' : ''}${notesLine}${linesLine}${schedLine}${docsLine}`
  const outcome = (l) => l.ok ? (l.dryRun ? 'would post' : 'posted') : (l.skipped ? 'skipped: ' + (l.reason || '') : 'FAIL: ' + (l.reason || l.error || ''))
  const detail = (s.log || [])
    .map(l => {
      if (l.noteId) return `note[${l.event ?? '?'}] job #${l.jobNumber ?? l.jobId ?? '?'} → ${outcome(l)}`
      if (l.invoiceNumber || l.amount) return `#${l.invoiceNumber ?? '?'} $${l.amount ?? '?'} → ${outcome(l)}`
      if (l.date && l.jobNumber) {
        // A Genie appointment: date and the window actually written (8-4 when the customer
        // chose "any time") — or which of the two steps failed. Status is left to dispatch.
        const win = l.window || ''
        return `appointment job #${l.jobNumber} → ${l.date}${win ? ' ' + win : ''} → ${outcome(l)}`
      }
      if (typeof l.lines === 'number' && l.jobNumber) return `lines job #${l.jobNumber} (${l.lines}) → ${outcome(l)}`
      if (l.scheduleQueueError) return `appointment queue: ${l.scheduleQueueError}`
      if (l.linesQueueError) return `line items queue: ${l.linesQueueError}`
      return null
    })
    .filter(Boolean).join('\n')
  // Approved-in-app lines the server couldn't queue (e.g. no linked open invoice).
  const skipDetail = skipped.length ? 'Skipped by server:\n' + skipped.map(x => `• ${x.reason || 'skipped'}`).join('\n') : ''
  el.textContent = [head, detail, skipDetail].filter(Boolean).join('\n\n')
}

document.getElementById('run').addEventListener('click', () => {
  const el = document.getElementById('status'); el.textContent = 'Running…'
  chrome.runtime.sendMessage({ type: 'run-now' }, () => render())
})

document.getElementById('crawl').addEventListener('click', () => {
  const el = document.getElementById('status')
  chrome.runtime.sendMessage({ type: 'genie-crawl-now' }, (r) => {
    el.textContent = r?.ok
      ? 'Full Genie crawl started in a background tab — it pages the whole list and details every order, then closes itself. Watch the [genie] console for progress.'
      : `Could not start crawl: ${r?.error || 'unknown'}`
  })
})
document.getElementById('crawlClopay').addEventListener('click', () => {
  const el = document.getElementById('status')
  chrome.runtime.sendMessage({ type: 'clopay-crawl-now' }, (r) => {
    el.textContent = r?.ok
      ? 'Full Clopay crawl started in a background tab — it pages the whole list and details every order, then closes itself. Watch the [clopay] console for progress.'
      : `Could not start crawl: ${r?.error || 'unknown'}`
  })
})
document.getElementById('syncClopayDocs').addEventListener('click', () => {
  const el = document.getElementById('status')
  chrome.runtime.sendMessage({ type: 'clopay-docsync-now' }, (r) => {
    el.textContent = r?.ok
      ? 'Clopay document sync started in a background tab — it downloads every order’s documents to Castle (skipping ones already stored), then closes itself. Slow; watch the [clopay] console. Safe to re-run — it resumes where it left off.'
      : `Could not start doc sync: ${r?.error || 'unknown'}`
  })
})
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage())

render()
