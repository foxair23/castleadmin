'use client'

import { useState } from 'react'

// Public, no-login approval screen. Shows the itemized quote + legal text, then
// requires an "I approve" checkbox + typed full-name signature (same mechanism as
// the commission acceptance panel) before the Approve button enables.
export default function ApproveClient({
  token,
  status,
  customerName,
  descriptionHtml,
  itemsHtml,
  legalHtml,
  legalVersion,
  approvedName,
  approvedAt,
}: {
  token: string
  status: 'pending' | 'approved' | 'declined' | 'expired'
  customerName: string | null
  descriptionHtml: string
  itemsHtml: string
  legalHtml: string
  legalVersion: string
  approvedName: string | null
  approvedAt: string | null
}) {
  const [agree, setAgree] = useState(false)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(status === 'approved')

  const canSubmit = agree && name.trim().length > 0 && !submitting

  async function handleApprove() {
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`/api/approve/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typed_name: name.trim(), agree: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to approve')
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to approve')
      setSubmitting(false)
    }
  }

  const isClosed = status !== 'pending' && status !== 'approved'

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-xl mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold text-gray-900">Castle Garage Doors &amp; Gates</h1>
          <p className="text-sm text-gray-500 mt-1">Work Authorization &amp; Approval</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {(done || status === 'approved') ? (
            <div className="px-6 py-8 text-center">
              <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <span className="text-green-600 text-2xl">✓</span>
              </div>
              <h2 className="text-lg font-semibold text-gray-900">Your approval is recorded.</h2>
              <p className="text-sm text-gray-600 mt-1">
                Thank you{customerName ? `, ${customerName}` : ''}. We&apos;ve emailed you a copy for your records.
              </p>
              {(approvedName || name) && (
                <p className="text-xs text-gray-400 mt-4">
                  Approved by {approvedName ?? name.trim()}{approvedAt ? ` on ${approvedAt}` : ''}.
                </p>
              )}
            </div>
          ) : isClosed ? (
            <div className="px-6 py-8 text-center">
              <h2 className="text-lg font-semibold text-gray-900">This request is no longer open.</h2>
              <p className="text-sm text-gray-600 mt-1">Please contact us at (800) 576-1397 if you have questions.</p>
            </div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-gray-200 bg-amber-50">
                <p className="text-sm text-gray-700">
                  {customerName ? `Hi ${customerName}, please` : 'Please'} review the work below and add your approval so
                  we can get started.
                </p>
              </div>

              {descriptionHtml && (
                <div className="px-5 pt-4">
                  <div className="text-gray-900" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
                </div>
              )}

              <div className="px-5 py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Your Quote</p>
                <div className="text-gray-900" dangerouslySetInnerHTML={{ __html: itemsHtml }} />
              </div>

              <div className="px-5 pb-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Authorization</p>
                <div
                  className="max-h-72 overflow-y-auto border border-gray-200 rounded-md p-4 bg-gray-50 text-gray-900"
                  dangerouslySetInnerHTML={{ __html: legalHtml }}
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
                  <span>I approve this work and its price, and I have read the authorization above.</span>
                </label>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">Type your full name to approve</label>
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
                  onClick={handleApprove}
                  disabled={!canSubmit}
                  className="inline-flex items-center gap-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium px-6 py-2 rounded-md"
                >
                  {submitting ? 'Submitting…' : 'Approve'}
                </button>
                <p className="text-xs text-gray-400">
                  Approving records your name, the date and time, and your device details as your electronic signature,
                  and emails you a copy. Approval version {legalVersion}.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
