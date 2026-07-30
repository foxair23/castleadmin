'use client'

import { useState, useEffect, useCallback } from 'react'
import { loadResendData, resendReminder } from './resend-actions'
import type { ResendData } from '@/lib/invoice-reminders/engine'

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/**
 * Manual "Resend Reminder" flow. Deliberately a two-step confirm so nobody
 * fires a customer message by accident: pick which stage of the series to send,
 * read the exact rendered message, then hit Send. Manual sends are logged
 * separately from the automated series.
 */
export default function ResendReminderModal({
  jobId,
  customerName,
  onClose,
  onSent,
}: {
  jobId: string
  customerName: string | null
  onClose: () => void
  onSent: () => void
}) {
  const [data, setData] = useState<ResendData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [stageIndex, setStageIndex] = useState<number>(0)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    loadResendData(jobId)
      .then(d => {
        if (!alive) return
        setData(d)
        if (d.ok && d.stages.length > 0) setStageIndex(d.stages[d.stages.length - 1].index) // default: last stage
      })
      .catch(() => { if (alive) setLoadError('Could not load reminder details.') })
    return () => { alive = false }
  }, [jobId])

  const handleSend = useCallback(async () => {
    if (!data?.sfInvoiceId) return
    setSending(true)
    setResult(null)
    try {
      const res = await resendReminder(data.sfInvoiceId, stageIndex)
      if (res.ok) {
        const chans = res.sent.map(c => (c === 'sms' ? 'text' : 'email')).join(' + ')
        onSent()
        setResult(`Sent (${chans}).`)
        setTimeout(onClose, 1200)
      } else {
        const map: Record<string, string> = {
          paid: 'This invoice has already been paid — nothing was sent.',
          no_channels: 'No deliverable channel (no contact info, or the customer opted out).',
          no_stage: 'That reminder stage no longer exists.',
          not_found: 'Invoice could not be found.',
        }
        const detail = res.failed.length ? ` (${res.failed.map(f => `${f.channel}: ${f.error}`).join('; ')})` : ''
        setResult((map[res.reason ?? ''] ?? 'Send failed.') + detail)
      }
    } catch {
      setResult('Send failed — please try again.')
    } finally {
      setSending(false)
    }
  }, [data, stageIndex, onClose, onSent])

  const selected = data?.stages.find(s => s.index === stageIndex) ?? null
  const canSend = !!selected && selected.willSend.length > 0 && !sending && !result?.startsWith('Sent')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Resend Reminder</h2>
            <p className="text-sm text-gray-500">{customerName ?? 'Customer'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {!data && !loadError && <p className="text-sm text-gray-500">Loading…</p>}
          {loadError && <p className="text-sm text-red-600">{loadError}</p>}

          {data && !data.ok && (
            <p className="text-sm text-red-600">
              {data.reason === 'no_cadence'
                ? 'No reminder cadence is configured yet.'
                : 'No unpaid invoice found for this job.'}
            </p>
          )}

          {data?.ok && (
            <>
              <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                This sends a real message to the customer now. Manual resends are logged separately from the
                automated series.
              </div>

              <div className="text-sm text-gray-700">
                Invoice <span className="font-medium">{data.invoiceNumber ?? '—'}</span> · balance{' '}
                <span className="font-medium text-red-700">{fmtMoney(data.amountDue)}</span>
              </div>

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Which reminder to send</span>
                <select
                  value={stageIndex}
                  onChange={e => { setStageIndex(Number(e.target.value)); setResult(null) }}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900"
                >
                  {data.stages.map(s => (
                    <option key={s.index} value={s.index}>
                      Day {s.day} — {s.channels.map(c => (c === 'sms' ? 'Text' : 'Email')).join(' + ')}
                      {s.index === data.stages.length - 1 ? ' (last)' : ''}
                    </option>
                  ))}
                </select>
              </label>

              {/* Inline preview of the exact message(s) that will be sent. */}
              {selected && (
                <div className="space-y-3">
                  {selected.willSend.length === 0 && (
                    <p className="text-sm text-red-600">
                      {selected.optedOut.length > 0
                        ? 'The customer has opted out on the channel(s) for this stage.'
                        : !data.hasEmail && !data.hasPhone
                          ? 'No email or phone on file for this customer.'
                          : 'This stage has no deliverable channel for this customer.'}
                    </p>
                  )}

                  {selected.email && (
                    <div className={`rounded-md border p-3 ${selected.willSend.includes('email') ? 'border-gray-200 bg-gray-50' : 'border-gray-200 bg-gray-50 opacity-50'}`}>
                      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                        ✉ Email {!selected.willSend.includes('email') && <span className="text-red-500 normal-case">(opted out — will not send)</span>}
                      </div>
                      <div className="text-xs text-gray-500">To: {selected.email.to}</div>
                      <div className="text-sm font-medium text-gray-900">{selected.email.subject}</div>
                      <div className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{selected.email.body}</div>
                    </div>
                  )}

                  {selected.sms && (
                    <div className={`rounded-md border p-3 ${selected.willSend.includes('sms') ? 'border-gray-200 bg-gray-50' : 'border-gray-200 bg-gray-50 opacity-50'}`}>
                      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                        📱 Text {!selected.willSend.includes('sms') && <span className="text-red-500 normal-case">(opted out — will not send)</span>}
                      </div>
                      <div className="text-xs text-gray-500">To: {selected.sms.to}</div>
                      <div className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{selected.sms.body}</div>
                    </div>
                  )}
                </div>
              )}

              {result && (
                <p className={`text-sm ${result.startsWith('Sent') ? 'text-green-700' : 'text-red-600'}`}>{result}</p>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? 'Sending…' : 'Send Reminder'}
          </button>
        </div>
      </div>
    </div>
  )
}
