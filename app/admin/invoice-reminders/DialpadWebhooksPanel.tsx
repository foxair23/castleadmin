'use client'

import { useEffect, useState, useTransition } from 'react'
import { listDialpadWebhooks, deleteDialpadWebhook, type WebhookRow } from './actions'

// Every webhook Dialpad has for the company, with the ones pointing at a
// different address than this app marked stale. Incoming texts (CSAT ratings,
// lead replies, STOP) only reach the app through a webhook at the current
// address; a stale one posts customer texts somewhere else. Dialpad has no
// screen for this, so it lives here.

export default function DialpadWebhooksPanel({ configured, refreshKey }: { configured: boolean; refreshKey: number }) {
  const [rows, setRows] = useState<WebhookRow[] | null>(null)
  const [hookUrl, setHookUrl] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  async function load() {
    setErr(null)
    const r = await listDialpadWebhooks()
    setHookUrl(r.hookUrl)
    setRows(r.webhooks)
    if (r.error) setErr(r.error)
  }
  useEffect(() => {
    if (!configured) return
    let cancelled = false
    listDialpadWebhooks().then(r => { if (cancelled) return; setHookUrl(r.hookUrl); setRows(r.webhooks); if (r.error) setErr(r.error) })
    return () => { cancelled = true }
  }, [configured, refreshKey])

  if (!configured) return null
  const current = rows?.filter(r => !r.stale) ?? []
  const stale = rows?.filter(r => r.stale) ?? []

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-gray-700">Dialpad webhooks</h3>
        <button onClick={() => start(load)} disabled={pending} className="text-xs text-gray-500 underline disabled:opacity-50">refresh</button>
      </div>
      <p className="text-xs text-gray-400 mt-0.5 mb-2">Incoming texts reach the app only through a webhook at <span className="font-mono">{hookUrl || '…'}</span>. One at another address keeps posting customer texts there.</p>
      {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
      {rows === null && !err && <p className="text-xs text-gray-400">Loading…</p>}
      {rows !== null && rows.length === 0 && !err && <p className="text-xs text-amber-700">Dialpad has no webhooks for this company. Click &ldquo;Re-point webhook to this app&rdquo; above.</p>}
      {rows !== null && rows.length > 0 && (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="py-1">Address</th><th>Subscriptions</th><th>Status</th><th></th></tr></thead>
          <tbody className="divide-y divide-gray-100">
            {[...current, ...stale].map(w => (
              <tr key={w.id}>
                <td className="py-1.5 font-mono break-all pr-2">{w.hookUrl || <span className="text-gray-400">(no address)</span>}</td>
                <td className="whitespace-nowrap">{w.subscriptions}</td>
                <td className="whitespace-nowrap">{w.stale
                  ? <span className="rounded bg-red-50 text-red-700 px-1.5 py-0.5">stale — not this app</span>
                  : <span className="rounded bg-green-50 text-green-700 px-1.5 py-0.5">current</span>}</td>
                <td className="text-right whitespace-nowrap">
                  <button
                    disabled={pending}
                    onClick={() => { if (confirm(w.stale ? 'Delete this stale webhook? Dialpad will stop posting texts to that address.' : 'This webhook is the one delivering texts to the app. Delete it anyway?')) start(async () => { const r = await deleteDialpadWebhook(w.id); if (!r.ok) setErr(r.error ?? 'delete failed'); await load() }) }}
                    className={`text-xs underline disabled:opacity-50 ${w.stale ? 'text-red-600' : 'text-gray-400'}`}
                  >Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {current.length === 0 && stale.length > 0 && <p className="text-xs text-amber-700 mt-2">No webhook points at this app. Click &ldquo;Re-point webhook to this app&rdquo; above, then delete the stale one.</p>}
    </div>
  )
}
