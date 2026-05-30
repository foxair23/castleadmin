'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export default function SyncFromMailchimpButton() {
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const router = useRouter()

  async function handleSync() {
    setMsg(null)
    const res = await fetch('/api/sales/sync', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      setMsg(data.error ?? 'Sync failed')
      return
    }
    const parts = [
      `Synced ${data.campaignsSynced} campaign${data.campaignsSynced !== 1 ? 's' : ''}`,
      `${data.totalOpeners} tagged contact${data.totalOpeners !== 1 ? 's' : ''} from Mailchimp`,
      `${data.newOpeners} new lead${data.newOpeners !== 1 ? 's' : ''} created`,
    ]
    if (data.unmatchedEmails > 0) parts.push(`${data.unmatchedEmails} unmatched`)
    setMsg(parts.join(' · '))
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex items-center">
      <button
        onClick={handleSync}
        disabled={pending}
        className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-60 transition-colors"
      >
        {pending ? 'Syncing…' : 'Sync from Mailchimp'}
      </button>
      {msg && <span className="ml-3 text-sm text-gray-600">{msg}</span>}
    </div>
  )
}
