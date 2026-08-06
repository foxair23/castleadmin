'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Pull recently changed / newly created SF jobs + invoices into the mirror, then
// re-run matching — so a job whose invoice you just corrected in SF (or a new job
// you created there) becomes matchable. Uses a fetch (long op) rather than a
// server action.
export function SyncFromSfButton() {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [msg, setMsg] = useState('')

  async function run() {
    if (state === 'running') return
    setState('running'); setMsg('')
    try {
      const res = await fetch('/api/remittance/sf-sync', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) throw new Error(d.error || 'Sync failed')
      setState('done')
      setMsg(`✓ ${d.jobs} jobs · ${d.invoices} invoices · ${d.rematched} re-matched`)
      router.refresh()
      setTimeout(() => { setState('idle'); setMsg('') }, 10000)
    } catch (e) {
      setState('error'); setMsg(e instanceof Error ? e.message : 'Sync failed')
    }
  }

  return (
    <span className="flex items-center gap-2">
      {msg && <span className={`text-xs max-w-[240px] ${state === 'error' ? 'text-red-600' : 'text-green-600'}`}>{msg}</span>}
      <button
        onClick={run}
        disabled={state === 'running'}
        title="Pull recently changed / newly created jobs & invoices from Service Fusion, then re-match"
        className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
      >
        {state === 'running' ? 'Syncing…' : 'Sync from SF'}
      </button>
    </span>
  )
}
