'use client'

import { useTransition } from 'react'
import { setAutopilotAction } from './actions'

// Genie autopilot: when ON, a cron auto-creates SF jobs for NEW orders (never the
// backlog). Admin-only to toggle; sales sees a read-only status pill.
export function AutopilotToggle({ on, canManage }: { on: boolean; canManage: boolean }) {
  const [pending, start] = useTransition()

  if (!canManage) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-gray-500">Autopilot</span>
        <span className={`px-2 py-0.5 rounded-full font-medium ${on ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'}`}>{on ? 'ON' : 'OFF'}</span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-gray-500">Autopilot (auto-create new Genie jobs)</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => start(async () => { await setAutopilotAction(!on) })}
        disabled={pending}
        title={on ? 'ON — new orders auto-create an SF job (never the backlog)' : 'OFF — create jobs manually with the button'}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? 'bg-green-600' : 'bg-gray-300'} disabled:opacity-50`}
      >
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-1'}`} />
      </button>
    </span>
  )
}
