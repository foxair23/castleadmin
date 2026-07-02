'use client'

import { useState } from 'react'

export interface AcceptanceInfo {
  needsAcceptance: true
  period: { start: string; end: string; label: string }
  legalVersion: string
  termsSummaryHtml: string
  legalHtml: string
}

// Shown in place of the commission figures when the tech has an unaccepted plan
// for the selected period. Requires an "I agree" checkbox + typed full-name
// signature before the Accept button enables.
export default function CommissionAcceptancePanel({
  info,
  onAccepted,
}: {
  info: AcceptanceInfo
  onAccepted: () => void
}) {
  const [agree, setAgree] = useState(false)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const canSubmit = agree && name.trim().length > 0 && !submitting

  async function handleAccept() {
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/tech/commission/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_start: info.period.start,
          period_end: info.period.end,
          typed_name: name.trim(),
          agree: true,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to accept')
      onAccepted()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to accept')
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 bg-amber-50">
        <h2 className="text-base font-semibold text-gray-900">Accept your commission agreement — {info.period.label}</h2>
        <p className="text-sm text-gray-600 mt-1">
          Your commission details for this period unlock once you review and accept the terms below.
        </p>
      </div>

      <div className="px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Your Plan Terms</p>
        <div className="text-gray-900" dangerouslySetInnerHTML={{ __html: info.termsSummaryHtml }} />
      </div>

      <div className="px-5 pb-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Agreement</p>
        <div
          className="max-h-80 overflow-y-auto border border-gray-200 rounded-md p-4 bg-gray-50 text-gray-900"
          dangerouslySetInnerHTML={{ __html: info.legalHtml }}
        />
      </div>

      <div className="px-5 py-4 border-t border-gray-200 space-y-3">
        <label className="flex items-start gap-2 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={agree}
            onChange={e => setAgree(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>I have read and agree to the commission agreement terms above.</span>
        </label>

        <div>
          <label className="block text-sm text-gray-600 mb-1">Type your full name to sign</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Full name"
            className="w-full max-w-sm border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          onClick={handleAccept}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-md"
        >
          {submitting ? 'Submitting…' : 'Accept agreement'}
        </button>
        <p className="text-xs text-gray-400">
          Accepting records your name, the date and time, and your device details as a binding acceptance, and emails you a copy. Agreement version {info.legalVersion}.
        </p>
      </div>
    </div>
  )
}
