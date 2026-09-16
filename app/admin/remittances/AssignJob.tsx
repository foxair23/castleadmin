'use client'

import { useState, useTransition } from 'react'
import { assignLineJobAction, unassignLineJobAction } from './actions'

export interface AssignCandidate { id: string; number: string | null; customer_name: string | null }

/** A line that already carries a job. The matcher keeps proposing the same wrong one on some
 *  lines, so this has to be undoable — and the undo has to stick, which is why it records a
 *  decision rather than just blanking the field. */
export function UnassignJob({ lineId, jobNumber, applied }: { lineId: string; jobNumber: string | null; applied: boolean }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  if (applied) return null
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        disabled={pending}
        title="Wrong job? Take it off — re-matching will not put it back"
        onClick={() => {
          if (!window.confirm(`Take job #${jobNumber ?? '—'} off this line?\n\nIt goes back to unmatched so you can type the right number, and re-matching will leave it alone from now on.`)) return
          setError(null)
          start(async () => { const r = await unassignLineJobAction(lineId); if (r?.error) setError(r.error) })
        }}
        className="text-[10px] text-gray-400 hover:text-red-600 underline disabled:opacity-50"
      >{pending ? 'unmatching…' : 'unmatch'}</button>
      {error && <span className="text-[10px] text-red-600 max-w-[200px] whitespace-normal">{error}</span>}
    </span>
  )
}

// Per-line manual allocation for unmatched/ambiguous remittance lines: pick from
// the suggested jobs, or type any job number. Typing a number takes precedence
// over the dropdown.
export function AssignJob({ lineId, candidates }: { lineId: string; candidates: AssignCandidate[] }) {
  const [pending, start] = useTransition()
  const [selected, setSelected] = useState('')
  const [num, setNum] = useState('')
  const [error, setError] = useState<string | null>(null)

  const canSubmit = !!num.trim() || !!selected
  function submit() {
    setError(null)
    start(async () => {
      const res = await assignLineJobAction(lineId, num.trim() ? { jobNumber: num.trim() } : { jobId: selected })
      if (res?.error) setError(res.error)
    })
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {candidates.length > 0 && (
          <select
            value={selected}
            onChange={e => { setSelected(e.target.value); setNum('') }}
            className="text-xs border border-gray-300 rounded px-1 py-0.5 text-gray-900 max-w-[200px]"
          >
            <option value="">Suggested job…</option>
            {candidates.map(c => (
              <option key={c.id} value={c.id}>#{c.number ?? c.id}{c.customer_name ? ` · ${c.customer_name}` : ''}</option>
            ))}
          </select>
        )}
        <input
          value={num}
          onChange={e => { setNum(e.target.value); setSelected('') }}
          placeholder="or Job #"
          inputMode="numeric"
          className="text-xs border border-gray-300 rounded px-1 py-0.5 text-gray-900 w-24"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || pending}
          className="text-xs px-2 py-0.5 rounded bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? 'Assigning…' : 'Assign'}
        </button>
      </div>
      {error && <span className="text-[10px] text-red-600">{error}</span>}
    </div>
  )
}
