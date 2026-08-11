'use client'

import { useState, useTransition } from 'react'
import { setNudgeSettingsAction } from './actions'

// Genie schedule nudge: when ON, a cron sends a one-time email + SMS to the
// customer of each NEW order (that already has an SF job) pointing them at the
// scheduler page below. Admin-only to change; sales sees a read-only pill.
// Turning it ON stamps a cutoff so the historical backlog is never messaged.
export function NudgeControls({ on, scheduleUrl, canManage }: { on: boolean; scheduleUrl: string | null; canManage: boolean }) {
  const [pending, start] = useTransition()
  const [url, setUrl] = useState(scheduleUrl ?? '')

  if (!canManage) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-gray-500">Schedule nudge</span>
        <span className={`px-2 py-0.5 rounded-full font-medium ${on ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'}`}>{on ? 'ON' : 'OFF'}</span>
      </span>
    )
  }

  const save = (nextEnabled: boolean, nextUrl: string) =>
    start(async () => { await setNudgeSettingsAction(nextEnabled, nextUrl.trim() || null) })

  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-gray-500">Schedule nudge (email + SMS to new customers)</span>
      <input
        type="url"
        value={url}
        onChange={e => setUrl(e.target.value)}
        onBlur={() => { if ((url.trim() || null) !== (scheduleUrl ?? null)) save(on, url) }}
        placeholder="https://…/schedule page"
        title="The customer-facing page where the Genie scheduler is embedded"
        disabled={pending}
        className="border border-gray-300 rounded px-2 py-0.5 text-xs text-gray-900 bg-white w-56"
      />
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => save(!on, url)}
        disabled={pending || (!on && !url.trim())}
        title={on ? 'ON — new customers get a one-time schedule nudge (never the backlog)' : (!url.trim() ? 'Set the scheduler page URL first' : 'OFF')}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? 'bg-green-600' : 'bg-gray-300'} disabled:opacity-50`}
      >
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-1'}`} />
      </button>
    </span>
  )
}
