'use client'

import { useState, useTransition } from 'react'
import { previewLineAction, applyLineAction, setLineExcludedAction } from './actions'
import type { PaymentPreview } from '@/lib/remittance/apply'

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// Per-line apply flow: Preview shows the exact SF payload without posting; Apply
// posts it; Exclude skips the line. Applied/excluded lines show their state.
export function ApplyControls({ lineId, applyStatus, matched, error }: { lineId: string; applyStatus: string; matched: boolean; error: string | null }) {
  const [pending, start] = useTransition()
  const [preview, setPreview] = useState<PaymentPreview | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  if (applyStatus === 'applied') return <span className="text-green-700 text-xs font-medium whitespace-nowrap">✓ applied</span>
  if (applyStatus === 'excluded') return (
    <button onClick={() => start(async () => { await setLineExcludedAction(lineId, false) })} disabled={pending}
      className="text-xs text-gray-400 hover:text-gray-700 underline whitespace-nowrap">excluded — undo</button>
  )
  if (!matched) return <span className="text-gray-300">—</span>

  const doPreview = () => { setMsg(null); start(async () => { const r = await previewLineAction(lineId); if (r.error) setMsg(r.error); else setPreview(r.preview ?? null) }) }
  const doApply = () => { setMsg(null); start(async () => { const r = await applyLineAction(lineId); if (r.error) setMsg(r.error) }) }
  const doExclude = () => { setMsg(null); start(async () => { const r = await setLineExcludedAction(lineId, true); if (r.error) setMsg(r.error) }) }

  return (
    <div className="flex flex-col gap-1 items-start">
      <div className="flex items-center gap-1">
        <button onClick={doPreview} disabled={pending} className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Preview</button>
        <button onClick={doApply} disabled={pending} className="text-xs px-2 py-0.5 rounded bg-green-700 text-white hover:bg-green-800 disabled:opacity-50">{pending ? '…' : 'Apply'}</button>
        <button onClick={doExclude} disabled={pending} title="Skip this line (e.g. handled manually in SF)" className="text-xs px-1.5 py-0.5 rounded text-gray-400 hover:text-gray-700">Exclude</button>
      </div>
      {(msg || (applyStatus === 'failed' && error)) && <span className="text-[10px] text-red-600 max-w-[240px]">{msg ?? error}</span>}
      {preview && (
        <div className="text-[10px] text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 max-w-[280px] leading-relaxed">
          <div className="font-medium text-gray-700">Would post to SF (preview only):</div>
          <div>Job #{preview.jobNumber} · {preview.customerName}</div>
          <div>{money(preview.payment.amount)} · ref <span className="font-mono">{preview.payment.reference_number || '—'}</span></div>
          <div>received_on {preview.payment.received_on ?? '—'} · apply_to {preview.payment.apply_to ?? '—'}</div>
          <div className="truncate" title={preview.payment.memo}>memo: {preview.payment.memo}</div>
          <div>existing SF payments on job: {preview.existingPaymentCount}{!preview.safeToApply && ' — blocked'}</div>
          {preview.warnings.map((w, i) => <div key={i} className="text-amber-700">⚠ {w}</div>)}
        </div>
      )}
    </div>
  )
}
