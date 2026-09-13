'use client'

import { useRef, useState } from 'react'
import { draftBacklogAction } from './reputation-actions'

// "Draft replies for old reviews" (PRD §4.4). Drafts unreplied historical reviews
// in batches until none are left or the person cancels; the backlog daily cap
// keeps the sends spread across days.

interface Props { defaultCap: number; onClose: () => void; onDone: () => void }

export default function BacklogDraftDialog({ defaultCap, onClose, onDone }: Props) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [positive, setPositive] = useState(true)
  const [negative, setNegative] = useState(true)
  const [cap, setCap] = useState(defaultCap)
  const [running, setRunning] = useState(false)
  const [drafted, setDrafted] = useState(0)
  const [scheduled, setScheduled] = useState(0)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const cancel = useRef(false)

  async function start() {
    setRunning(true); setErr(null); setDrafted(0); setScheduled(0); setRemaining(null); cancel.current = false
    const bands = [...(positive ? ['positive' as const] : []), ...(negative ? ['negative' as const] : [])]
    let total = 0, sched = 0
    for (let i = 0; i < 40; i++) {
      const r = await draftBacklogAction({ from: from || null, to: to || null, bands, dailyCap: cap })
      if (r.error) { setErr(r.error); break }
      total += r.drafted ?? 0; sched += r.scheduled ?? 0
      setDrafted(total); setScheduled(sched); setRemaining(r.remaining ?? 0)
      if (r.reason) setErr(r.reason)
      if (!r.remaining || (r.drafted ?? 0) === 0 || cancel.current) break
    }
    setRunning(false); onDone()
  }

  const input = 'text-sm border border-gray-300 rounded-md px-2 py-1.5 text-gray-900 bg-white'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-gray-900 mb-1">Draft replies for old reviews</h3>
        <p className="text-xs text-gray-500 mb-4">Every unreplied review in the range gets a draft. With a band&rsquo;s autopilot on, its drafts schedule themselves at the daily backlog cap; otherwise they wait under &ldquo;Needs approval&rdquo;. Oldest first.</p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="text-xs text-gray-600">From<input type="date" value={from} onChange={e => setFrom(e.target.value)} className={`${input} w-full mt-1`} /></label>
          <label className="text-xs text-gray-600">To<input type="date" value={to} onChange={e => setTo(e.target.value)} className={`${input} w-full mt-1`} /></label>
        </div>
        <div className="flex gap-4 mb-3 text-sm text-gray-700">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={positive} onChange={e => setPositive(e.target.checked)} /> 4–5 star</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={negative} onChange={e => setNegative(e.target.checked)} /> 1–3 star</label>
        </div>
        <label className="text-xs text-gray-600 block mb-4">Backlog replies per day (sends, not drafts)
          <input type="number" min={0} max={50} value={cap} onChange={e => setCap(Number(e.target.value))} className={`${input} w-24 mt-1 block`} />
        </label>
        {(running || remaining != null) && (
          <p className="text-sm text-gray-700 mb-3">{drafted} drafted{scheduled ? ` (${scheduled} scheduled by autopilot)` : ''}{remaining != null ? ` · ${remaining} remaining` : ''}{running ? '…' : ''}</p>
        )}
        {err && <p className="text-xs text-red-600 mb-3">{err}</p>}
        <div className="flex gap-2 justify-end">
          {running
            ? <button className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-600" onClick={() => { cancel.current = true }}>Stop after this batch</button>
            : <>
              <button className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-600" onClick={onClose}>Close</button>
              <button disabled={!positive && !negative} className="text-sm px-3 py-1.5 rounded bg-gray-900 text-white disabled:opacity-50" onClick={start}>Start</button>
            </>}
        </div>
      </div>
    </div>
  )
}
