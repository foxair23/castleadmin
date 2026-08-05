'use client'

import { useTransition } from 'react'

// Server-action button with a pending state. A bare <form action={...}> server
// action gives no click feedback; this shows the button depress + a "…" label
// while the action runs, and disables it to prevent double-submits.
export function ActionButton({ action, label, pendingLabel, className }: {
  action: () => Promise<void>
  label: string
  pendingLabel: string
  className?: string
}) {
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      onClick={() => start(async () => { await action() })}
      disabled={pending}
      aria-busy={pending}
      className={`${className ?? ''} disabled:opacity-60 disabled:cursor-progress`}
    >
      {pending ? pendingLabel : label}
    </button>
  )
}
