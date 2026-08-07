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
  const head = s.error
    ? `Error: ${s.error}`
    : `Last run: ${fmt(s.at)}\nqueued ${s.queued ?? 0} · applied ${s.applied ?? 0} · failed ${s.failed ?? 0} · skipped ${skipped.length}${s.dryRun ? ' (dry run)' : ''}${notesLine}`
  const detail = (s.log || [])
    .map(l => l.noteId
      ? `note[${l.event ?? '?'}] job #${l.jobNumber ?? l.jobId ?? '?'} → ${l.ok ? (l.dryRun ? 'would post' : 'posted') : 'FAIL: ' + (l.error || '')}`
      : l.invoiceNumber || l.amount ? `#${l.invoiceNumber ?? '?'} $${l.amount ?? '?'} → ${l.ok ? (l.dryRun ? 'would post' : 'posted') : 'FAIL: ' + (l.error || '')}` : null)
    .filter(Boolean).join('\n')
  // Approved-in-app lines the server couldn't queue (e.g. no linked open invoice).
  const skipDetail = skipped.length ? 'Skipped by server:\n' + skipped.map(x => `• ${x.reason || 'skipped'}`).join('\n') : ''
  el.textContent = [head, detail, skipDetail].filter(Boolean).join('\n\n')
}

document.getElementById('run').addEventListener('click', () => {
  const el = document.getElementById('status'); el.textContent = 'Running…'
  chrome.runtime.sendMessage({ type: 'run-now' }, () => render())
})
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage())

render()
