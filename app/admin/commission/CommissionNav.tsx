'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'

// Secondary nav for the admin Commission area. Tabs are added here as later
// phases land (Review queue, Leaderboard).
const TABS: { href: string; label: string; match: (p: string) => boolean }[] = [
  { href: '/admin/commission/techs', label: 'Technicians', match: p => p === '/admin/commission' || p.startsWith('/admin/commission/techs') },
  { href: '/admin/commission/plans', label: 'Plans', match: p => p.startsWith('/admin/commission/plans') },
  { href: '/admin/commission/review', label: 'Review', match: p => p.startsWith('/admin/commission/review') },
  { href: '/admin/commission/acceptances', label: 'Acceptances', match: p => p.startsWith('/admin/commission/acceptances') },
  { href: '/admin/commission/leaderboard', label: 'Leaderboard', match: p => p.startsWith('/admin/commission/leaderboard') },
  { href: '/admin/commission/agents', label: 'Agent Mapping', match: p => p.startsWith('/admin/commission/agents') },
]

// Manual recompute: re-scans every job (tokens, agents, work-completed dates,
// paid invoices) and rebuilds eligibility + snapshots. The same recompute runs
// automatically after saving a token/agent mapping; this button covers every
// other case (new notes synced from SF, a deploy that changed the rules, …).
function RecomputeButton() {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function run() {
    if (state === 'running') return
    setState('running')
    setMessage('')
    try {
      const res = await fetch('/api/admin/commission/refresh', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || 'Recompute failed')
      setState('done')
      setMessage(`✓ ${data.scanned} jobs scanned`)
      router.refresh()
      setTimeout(() => { setState('idle'); setMessage('') }, 6000)
    } catch (e) {
      setState('error')
      setMessage(e instanceof Error ? e.message : 'Recompute failed')
    }
  }

  return (
    <span className="ml-auto flex items-center gap-2 pb-2">
      {message && (
        <span className={`text-xs ${state === 'error' ? 'text-red-600' : 'text-green-600'}`}>{message}</span>
      )}
      <button
        onClick={run}
        disabled={state === 'running'}
        title="Re-scan all jobs (notes, tokens, agents, payments) and rebuild commission"
        className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
      >
        {state === 'running' ? 'Recomputing…' : '↻ Recompute'}
      </button>
    </span>
  )
}

export default function CommissionNav() {
  const pathname = usePathname()
  return (
    <div className="flex gap-4 border-b border-gray-200 mb-6 items-end">
      {TABS.map(t => {
        const active = t.match(pathname)
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`pb-2 text-sm font-medium transition-colors ${
              active
                ? 'text-gray-900 border-b-2 border-red-500'
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
      <RecomputeButton />
    </div>
  )
}
