'use client'

import { useTransition } from 'react'
import { setAutopilotAction } from './actions'

// Per-vendor autopilot: when ON, confident PO / PO+name matches auto-apply on
// ingest. Name-only, AI, manual, and ambiguous matches always wait for a human.
export function AutopilotToggle({ vendorId, vendorName, on }: { vendorId: string; vendorName: string; on: boolean }) {
  const [pending, start] = useTransition()
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-gray-500">{vendorName} autopilot</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => start(async () => { await setAutopilotAction(vendorId, !on) })}
        disabled={pending}
        title={on ? 'ON — confident PO matches auto-apply on ingest' : 'OFF — every line waits for manual approval'}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? 'bg-green-600' : 'bg-gray-300'} disabled:opacity-50`}
      >
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-1'}`} />
      </button>
    </span>
  )
}
