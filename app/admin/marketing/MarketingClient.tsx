'use client'

import { useState, useRef } from 'react'

interface FilterOption {
  id: string
  name: string
}

interface ContactRow {
  customer_id: string
  customer_name: string | null
  email: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  city: string | null
  postal_code: string | null
  lead_source: string | null
  last_serviced_date: string | null
  account_balance: number | null
}

interface PushResult {
  added: number
  updated: number
  skipped: number
  errored: number
  errors: { email: string; error: string }[]
}

const RECENCY_OPTIONS = [
  { value: '', label: 'All time' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 6 months' },
  { value: '365', label: 'Last 12 months' },
  { value: '180:365', label: '6–12 months ago' },
  { value: '365:730', label: '1–2 years ago' },
  { value: '730:1825', label: '2–5 years ago' },
  { value: 'custom', label: 'Custom range…' },
]

export default function MarketingClient({
  leadSources,
  jobCategories,
}: {
  leadSources: FilterOption[]
  jobCategories: FilterOption[]
}) {
  // Filter state
  const [recency, setRecency] = useState('')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set())
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set())
  const [outstandingOnly, setOutstandingOnly] = useState(false)

  // Results state
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [loading, setLoading] = useState(false)
  const [filtersApplied, setFiltersApplied] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Action bar state
  const [tag, setTag] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<PushResult | null>(null)
  const [pushError, setPushError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  const confirmRef = useRef<HTMLDivElement>(null)

  function toggleSource(id: string) {
    setSelectedSources(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleCategory(id: string) {
    setSelectedCategories(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function applyFilters() {
    setLoading(true)
    setFetchError(null)
    setPushResult(null)
    setSelectedIds(new Set())
    setFiltersApplied(true)

    const params = new URLSearchParams()
    if (recency === 'custom') {
      if (customFrom) params.set('date_from', customFrom)
      if (customTo) params.set('date_to', customTo)
    } else if (recency) {
      params.set('recency', recency)
    }
    if (selectedSources.size > 0) params.set('lead_sources', Array.from(selectedSources).join(','))
    if (selectedCategories.size > 0) params.set('job_categories', Array.from(selectedCategories).join(','))
    if (outstandingOnly) params.set('payment_filter', 'outstanding')

    try {
      const res = await fetch(`/api/admin/marketing/contacts?${params.toString()}`)
      const data = await res.json()
      if (!res.ok) {
        setFetchError(data.error ?? 'Failed to load contacts')
        setContacts([])
      } else {
        setContacts(data.contacts ?? [])
      }
    } catch {
      setFetchError('Network error')
      setContacts([])
    } finally {
      setLoading(false)
    }
  }

  function toggleSelectAll() {
    if (selectedIds.size === contacts.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(contacts.map(c => c.customer_id)))
    }
  }

  function toggleRow(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handlePush() {
    if (!tag.trim() || selectedIds.size === 0) return
    setPushing(true)
    setPushError(null)
    setPushResult(null)
    setShowConfirm(false)

    try {
      const res = await fetch('/api/admin/marketing/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds: Array.from(selectedIds), tag: tag.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPushError(data.error ?? 'Push failed')
      } else {
        setPushResult(data as PushResult)
      }
    } catch {
      setPushError('Network error')
    } finally {
      setPushing(false)
    }
  }

  async function handleDownloadCSV() {
    if (selectedIds.size === 0) return
    setDownloading(true)
    try {
      const res = await fetch('/api/admin/marketing/csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds: Array.from(selectedIds) }),
      })
      if (!res.ok) {
        const data = await res.json()
        alert(data.error ?? 'Download failed')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const date = new Date().toISOString().slice(0, 10)
      a.href = url
      a.download = `contacts-${date}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('Download failed')
    } finally {
      setDownloading(false)
    }
  }

  const allSelected = contacts.length > 0 && selectedIds.size === contacts.length
  const someSelected = selectedIds.size > 0

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-white mb-6">Marketing Contacts</h1>

      <div className="flex gap-6">
        {/* Left panel — Filters */}
        <div className="w-64 shrink-0">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-5">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Filters</h2>

            {/* Recency */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Last Service Date</label>
              <select
                value={recency}
                onChange={e => setRecency(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:border-gray-500"
              >
                {RECENCY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {recency === 'custom' && (
                <div className="mt-2 space-y-2">
                  <div>
                    <label className="block text-xs text-gray-500 mb-0.5">From</label>
                    <input
                      type="date"
                      value={customFrom}
                      onChange={e => setCustomFrom(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:border-gray-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-0.5">To</label>
                    <input
                      type="date"
                      value={customTo}
                      onChange={e => setCustomTo(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:border-gray-500"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Lead Source */}
            {leadSources.length > 0 && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Lead Source</label>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {leadSources.map(src => (
                    <label key={src.name} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedSources.has(src.name)}
                        onChange={() => toggleSource(src.name)}
                        className="accent-red-500"
                      />
                      <span className="text-sm text-gray-300">{src.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Job Category */}
            {jobCategories.length > 0 && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Job Category</label>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {jobCategories.map(cat => (
                    <label key={cat.name} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedCategories.has(cat.name)}
                        onChange={() => toggleCategory(cat.name)}
                        className="accent-red-500"
                      />
                      <span className="text-sm text-gray-300">{cat.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Payment Status */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={outstandingOnly}
                  onChange={e => setOutstandingOnly(e.target.checked)}
                  className="accent-red-500"
                />
                <span className="text-sm text-gray-300">Has outstanding balance only</span>
              </label>
            </div>

            <button
              onClick={applyFilters}
              disabled={loading}
              className="w-full bg-red-600 hover:bg-red-500 disabled:bg-red-900 text-white text-sm font-medium py-2 rounded transition-colors"
            >
              {loading ? 'Loading...' : 'Apply Filters'}
            </button>
          </div>
        </div>

        {/* Main area */}
        <div className="flex-1 min-w-0">
          {!filtersApplied && !loading && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center text-gray-500">
              Apply filters to load contacts.
            </div>
          )}

          {loading && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="h-8 bg-gray-800 rounded animate-pulse" />
              ))}
            </div>
          )}

          {fetchError && (
            <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-400 text-sm">
              {fetchError}
            </div>
          )}

          {!loading && filtersApplied && !fetchError && (
            <>
              <div className="text-sm text-gray-400 mb-2">
                Showing {contacts.length} contact{contacts.length !== 1 ? 's' : ''}
                {selectedIds.size > 0 && (
                  <span className="ml-3 text-white font-medium">{selectedIds.size} selected</span>
                )}
              </div>

              {contacts.length === 0 ? (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center text-gray-500">
                  No contacts match the selected filters.
                </div>
              ) : (
                <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-800">
                          <th className="px-3 py-2 text-left">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={toggleSelectAll}
                              className="accent-red-500"
                            />
                          </th>
                          <th className="px-3 py-2 text-left text-gray-400 font-medium">Customer</th>
                          <th className="px-3 py-2 text-left text-gray-400 font-medium">Email</th>
                          <th className="px-3 py-2 text-left text-gray-400 font-medium">Phone</th>
                          <th className="px-3 py-2 text-left text-gray-400 font-medium">City</th>
                          <th className="px-3 py-2 text-left text-gray-400 font-medium">Lead Source</th>
                          <th className="px-3 py-2 text-left text-gray-400 font-medium">Last Serviced</th>
                          <th className="px-3 py-2 text-right text-gray-400 font-medium">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {contacts.map(c => (
                          <tr
                            key={c.customer_id}
                            className={`border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer ${selectedIds.has(c.customer_id) ? 'bg-gray-800/70' : ''}`}
                            onClick={() => toggleRow(c.customer_id)}
                          >
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={selectedIds.has(c.customer_id)}
                                onChange={() => toggleRow(c.customer_id)}
                                onClick={e => e.stopPropagation()}
                                className="accent-red-500"
                              />
                            </td>
                            <td className="px-3 py-2 text-white">{c.customer_name ?? c.customer_id}</td>
                            <td className="px-3 py-2 text-gray-300">{c.email ?? <span className="text-gray-600">—</span>}</td>
                            <td className="px-3 py-2 text-gray-300">{c.phone ?? <span className="text-gray-600">—</span>}</td>
                            <td className="px-3 py-2 text-gray-300">{c.city ?? <span className="text-gray-600">—</span>}</td>
                            <td className="px-3 py-2 text-gray-300">{c.lead_source ?? <span className="text-gray-600">—</span>}</td>
                            <td className="px-3 py-2 text-gray-300">{c.last_serviced_date ?? <span className="text-gray-600">—</span>}</td>
                            <td className="px-3 py-2 text-right text-gray-300">
                              {c.account_balance != null ? `$${c.account_balance.toFixed(2)}` : <span className="text-gray-600">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Push result banner */}
          {pushResult && (
            <div className="mt-4 bg-green-900/30 border border-green-800 rounded-lg p-4 text-sm text-green-300">
              Added: {pushResult.added} | Updated: {pushResult.updated} | Skipped (unsubscribed): {pushResult.skipped} | Errors: {pushResult.errored}
            </div>
          )}

          {pushError && (
            <div className="mt-4 bg-red-900/30 border border-red-800 rounded-lg p-4 text-sm text-red-400">
              Push failed: {pushError}
            </div>
          )}
        </div>
      </div>

      {/* Bottom action bar */}
      {someSelected && (
        <div className="fixed bottom-0 left-0 right-0 bg-gray-950 border-t border-gray-800 px-6 py-4 z-10">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-4">
            <span className="text-sm text-gray-400">{selectedIds.size} selected</span>

            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-300 whitespace-nowrap">Tag name:</label>
              <input
                type="text"
                value={tag}
                onChange={e => setTag(e.target.value)}
                placeholder="e.g. spring-2026-tuneup"
                className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-3 py-1.5 w-52 focus:outline-none focus:border-gray-500 placeholder-gray-600"
              />
            </div>

            <button
              onClick={() => setShowConfirm(true)}
              disabled={!tag.trim() || pushing}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:text-blue-400 text-white text-sm font-medium px-4 py-1.5 rounded transition-colors"
            >
              {pushing ? 'Pushing...' : 'Push to Mailchimp'}
            </button>

            <button
              onClick={handleDownloadCSV}
              disabled={downloading}
              className="bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white text-sm font-medium px-4 py-1.5 rounded transition-colors"
            >
              {downloading ? 'Downloading...' : 'Download CSV'}
            </button>
          </div>
        </div>
      )}

      {/* Confirmation dialog */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-20" onClick={() => setShowConfirm(false)}>
          <div
            ref={confirmRef}
            className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-md w-full mx-4"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-white mb-3">Confirm Push</h2>
            <p className="text-gray-300 text-sm mb-6">
              Push <strong>{selectedIds.size}</strong> contact{selectedIds.size !== 1 ? 's' : ''} to Mailchimp with tag <strong>&apos;{tag}&apos;</strong>?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowConfirm(false)}
                className="bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handlePush}
                className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
              >
                Confirm Push
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
