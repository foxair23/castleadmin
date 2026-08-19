'use client'

import { useState, useTransition } from 'react'
import { setStsSettingsAction } from './actions'

// Clopay STS auto-request: when ON, a cron emails the DC once for each NEW STS
// order (cc info@castlegaragedoors.com) asking for delivery details. Admin-only
// to change; sales sees a read-only pill. Turning it ON stamps a cutoff so the
// historical backlog is never emailed.
export function StsControls({ on, dcEmail, canManage }: { on: boolean; dcEmail: string; canManage: boolean }) {
  const [pending, start] = useTransition()
  const [email, setEmail] = useState(dcEmail ?? '')

  if (!canManage) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-gray-500">Auto-request from DC</span>
        <span className={`px-2 py-0.5 rounded-full font-medium ${on ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'}`}>{on ? 'ON' : 'OFF'}</span>
      </span>
    )
  }

  const save = (nextEnabled: boolean, nextEmail: string) =>
    start(async () => { await setStsSettingsAction(nextEnabled, nextEmail.trim()) })

  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-gray-500">Auto-request from DC (email new orders)</span>
      <input
        type="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        onBlur={() => { if (email.trim() !== (dcEmail ?? '')) save(on, email) }}
        placeholder="sandiegodc@clopay.com"
        title="Distribution Center email — where “please send details” requests go"
        disabled={pending}
        className="border border-gray-300 rounded px-2 py-0.5 text-xs text-gray-900 bg-white w-52"
      />
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => save(!on, email)}
        disabled={pending || (!on && !email.trim())}
        title={on ? 'ON — new STS orders auto-email the DC (never the backlog)' : (!email.trim() ? 'Set the DC email first' : 'OFF')}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? 'bg-green-600' : 'bg-gray-300'} disabled:opacity-50`}
      >
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-1'}`} />
      </button>
    </span>
  )
}
