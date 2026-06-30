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

interface MarketingFilters {
  recency?: string
  dateFrom?: string
  dateTo?: string
  leadSources?: string[]
  jobCategories?: string[]
  paymentFilter?: string
}

const PAGE_SIZE = 250

interface PushResult {
  total: number
  audience_added: number
  audience_updated: number
  audience_unchanged: number
  audience_skipped: number
  audience_errored: number
  tagged: number
  not_taggable: number
  errors: { email: string; error: string }[]
}

const RECENCY_OPTIONS = [
  { value: '', label: 'All time' },
  { value: 'none', label: 'No service date' },
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
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [filtersApplied, setFiltersApplied] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  // The filters that produced the current results (used for "select all matching").
  const [appliedFilters, setAppliedFilters] = useState<MarketingFilters | null>(null)

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // When true, the send targets EVERY contact matching the applied filters
  // (across all pages), not just the checked rows.
  const [selectAllMatching, setSelectAllMatching] = useState(false)

  // Action bar state
  const [tag, setTag] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pushProgress, setPushProgress] = useState<{ done: number; total: number } | null>(null)
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

  function buildFilters(): MarketingFilters {
    return {
      recency: recency === 'custom' ? undefined : (recency || undefined),
      dateFrom: recency === 'custom' ? (customFrom || undefined) : undefined,
      dateTo: recency === 'custom' ? (customTo || undefined) : undefined,
      leadSources: Array.from(selectedSources),
      jobCategories: Array.from(selectedCategories),
      paymentFilter: outstandingOnly ? 'outstanding' : undefined,
    }
  }

  async function loadPage(p: number, f: MarketingFilters) {
    setLoading(true)
    setFetchError(null)
    const params = new URLSearchParams()
    if (f.recency) params.set('recency', f.recency)
    if (f.dateFrom) params.set('date_from', f.dateFrom)
    if (f.dateTo) params.set('date_to', f.dateTo)
    if (f.leadSources?.length) params.set('lead_sources', f.leadSources.join(','))
    if (f.jobCategories?.length) params.set('job_categories', f.jobCategories.join(','))
    if (f.paymentFilter) params.set('payment_filter', f.paymentFilter)
    params.set('page', String(p))
    params.set('page_size', String(PAGE_SIZE))
    try {
      const res = await fetch(`/api/admin/marketing/contacts?${params.toString()}`)
      const data = await res.json()
      if (!res.ok) {
        setFetchError(data.error ?? 'Failed to load contacts')
        setContacts([])
      } else {
        setContacts(data.contacts ?? [])
        setTotal(data.total ?? 0)
        setPage(p)
      }
    } catch {
      setFetchError('Network error')
      setContacts([])
    } finally {
      setLoading(false)
    }
  }

  async function applyFilters() {
    const f = buildFilters()
    setAppliedFilters(f)
    setPushResult(null)
    setSelectedIds(new Set())
    setSelectAllMatching(false)
    setFiltersApplied(true)
    await loadPage(1, f)
  }

  // Header checkbox toggles selection for the rows on the current page only.
  function toggleSelectAllOnPage() {
    const pageIds = contacts.map(c => c.customer_id)
    const allOnPageSelected = pageIds.every(id => selectedIds.has(id))
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allOnPageSelected) pageIds.forEach(id => next.delete(id))
      else pageIds.forEach(id => next.add(id))
      return next
    })
    if (selectAllMatching) setSelectAllMatching(false)
  }

  function toggleRow(id: string) {
    if (selectAllMatching) setSelectAllMatching(false)
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function clearSelection() {
    setSelectedIds(new Set())
    setSelectAllMatching(false)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageIds = contacts.map(c => c.customer_id)
  const allOnPageSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id))
  // Effective count being sent: all matching, or just the checked rows.
  const effectiveCount = selectAllMatching ? total : selectedIds.size

  // Body for push/csv: send filters when "all matching", else the checked ids.
  function selectionBody() {
    return selectAllMatching
      ? { filters: appliedFilters, allMatching: true }
      : { customerIds: Array.from(selectedIds) }
  }

  // Push in small batches so no single request runs long enough to hit a
  // gateway timeout. The server resolves the selection to ids; the client then
  // pushes 500 at a time, aggregating the per-batch results.
  const PUSH_CHUNK = 500
  async function handlePush() {
    if (!tag.trim() || effectiveCount === 0) return
    setPushing(true)
    setPushError(null)
    setPushResult(null)
    setPushProgress(null)
    try {
      // 1. Resolve the selection (or "all matching" filters) to a flat id list.
      const idsRes = await fetch('/api/admin/marketing/ids', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectionBody()),
      })
      const idsData = await idsRes.json()
      if (!idsRes.ok) throw new Error(idsData.error ?? 'Failed to resolve contacts')
      const ids: string[] = idsData.ids ?? []
      if (ids.length === 0) { setPushError('No contacts to push'); setPushing(false); return }

      // 2. Push in chunks, aggregating results.
      const agg: PushResult = { total: 0, audience_added: 0, audience_updated: 0, audience_unchanged: 0, audience_skipped: 0, audience_errored: 0, tagged: 0, not_taggable: 0, errors: [] }
      setPushProgress({ done: 0, total: ids.length })

      for (let i = 0; i < ids.length; i += PUSH_CHUNK) {
        const chunk = ids.slice(i, i + PUSH_CHUNK)
        const batchNo = Math.floor(i / PUSH_CHUNK) + 1
        let done = false
        for (let attempt = 0; attempt < 2 && !done; attempt++) {
          try {
            const res = await fetch('/api/admin/marketing/push', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ customerIds: chunk, tag: tag.trim() }),
            })
            const data = await res.json()
            if (!res.ok) {
              agg.errors.push({ email: `(batch ${batchNo})`, error: data.error ?? `HTTP ${res.status}` })
              done = true // don't retry a server-side error
            } else {
              const r = data as PushResult
              agg.total += r.total; agg.audience_added += r.audience_added
              agg.audience_updated += r.audience_updated; agg.audience_unchanged += r.audience_unchanged
              agg.audience_skipped += r.audience_skipped; agg.audience_errored += r.audience_errored
              agg.tagged += r.tagged; agg.not_taggable += r.not_taggable
              if (r.errors?.length) agg.errors.push(...r.errors)
              done = true
            }
          } catch {
            if (attempt === 1) agg.errors.push({ email: `(batch ${batchNo})`, error: 'Network error on this batch' })
            // otherwise fall through to one retry
          }
        }
        setPushProgress({ done: Math.min(i + PUSH_CHUNK, ids.length), total: ids.length })
      }
      setPushResult(agg)
    } catch (e) {
      setPushError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setPushing(false)
      setPushProgress(null)
    }
  }

  function handleDismissResult() {
    setShowConfirm(false)
    setPushResult(null)
    setPushError(null)
  }

  async function handleDownloadCSV() {
    if (effectiveCount === 0) return
    setDownloading(true)
    try {
      const res = await fetch('/api/admin/marketing/csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectionBody()),
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

  const someSelected = selectAllMatching || selectedIds.size > 0
  const selectedWithEmail = contacts.filter(c => selectedIds.has(c.customer_id) && c.email).length
  const selectedSmsOnly = selectedIds.size - selectedWithEmail

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
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-sm text-gray-400">
                  {total.toLocaleString()} contact{total !== 1 ? 's' : ''} match
                  {total > 0 && (
                    <span className="ml-1 text-gray-500">
                      · showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)}
                    </span>
                  )}
                  {effectiveCount > 0 && (
                    <span className="ml-3 text-white font-medium">{effectiveCount.toLocaleString()} selected</span>
                  )}
                </div>
                {totalPages > 1 && (
                  <div className="flex items-center gap-2 text-sm">
                    <button
                      onClick={() => appliedFilters && loadPage(page - 1, appliedFilters)}
                      disabled={page <= 1 || loading}
                      className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
                    >Prev</button>
                    <span className="text-gray-400">Page {page} of {totalPages}</span>
                    <button
                      onClick={() => appliedFilters && loadPage(page + 1, appliedFilters)}
                      disabled={page >= totalPages || loading}
                      className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
                    >Next</button>
                  </div>
                )}
              </div>

              {/* Select-all-matching banner (Gmail style) */}
              {contacts.length > 0 && (allOnPageSelected || selectAllMatching) && total > contacts.length && (
                <div className="bg-blue-950/40 border border-blue-900 rounded px-3 py-2 mb-2 text-sm text-blue-200 flex items-center justify-between gap-3">
                  {selectAllMatching ? (
                    <>
                      <span>All <strong>{total.toLocaleString()}</strong> contacts matching your filters are selected.</span>
                      <button onClick={clearSelection} className="text-blue-300 hover:text-white underline">Clear selection</button>
                    </>
                  ) : (
                    <>
                      <span>All {contacts.length} on this page are selected.</span>
                      <button onClick={() => setSelectAllMatching(true)} className="text-blue-300 hover:text-white underline">
                        Select all {total.toLocaleString()} matching your filters
                      </button>
                    </>
                  )}
                </div>
              )}

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
                              checked={allOnPageSelected || selectAllMatching}
                              onChange={toggleSelectAllOnPage}
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
                            className={`border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer ${(selectAllMatching || selectedIds.has(c.customer_id)) ? 'bg-gray-800/70' : ''}`}
                            onClick={() => toggleRow(c.customer_id)}
                          >
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={selectAllMatching || selectedIds.has(c.customer_id)}
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

        </div>
      </div>

      {/* Bottom action bar */}
      {someSelected && (
        <div className="fixed bottom-0 left-0 right-0 bg-gray-950 border-t border-gray-800 px-6 py-4 z-10">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-4">
            <span className="text-sm text-gray-400">{effectiveCount.toLocaleString()} selected</span>

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

      {/* Confirm / pushing / result dialog */}
      {showConfirm && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-20"
          onClick={!pushing ? handleDismissResult : undefined}
        >
          <div
            ref={confirmRef}
            className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-md w-full mx-4"
            onClick={e => e.stopPropagation()}
          >
            {/* ── Pushing (loading) state ── */}
            {pushing && (
              <div className="text-center py-6">
                <div className="text-gray-300 text-sm mb-2">Pushing to Mailchimp…</div>
                {pushProgress ? (
                  <>
                    <div className="text-gray-400 text-sm">
                      {pushProgress.done.toLocaleString()} / {pushProgress.total.toLocaleString()}
                    </div>
                    <div className="mt-2 h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${pushProgress.total ? (pushProgress.done / pushProgress.total) * 100 : 0}%` }}
                      />
                    </div>
                    <div className="text-gray-500 text-xs mt-2">Keep this tab open until it finishes</div>
                  </>
                ) : (
                  <div className="text-gray-500 text-xs">Preparing…</div>
                )}
              </div>
            )}

            {/* ── Result state ── */}
            {!pushing && pushResult && (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded-full bg-green-900/60 flex items-center justify-center shrink-0">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <h2 className="text-base font-semibold text-white">
                    {(pushResult.audience_added + pushResult.audience_updated + pushResult.audience_unchanged).toLocaleString()} contact
                    {(pushResult.audience_added + pushResult.audience_updated + pushResult.audience_unchanged) !== 1 ? 's' : ''} pushed to Mailchimp
                  </h2>
                </div>
                <div className="bg-gray-800 rounded px-3 py-3 text-sm space-y-2 mb-4">
                  {/* Audience upsert breakdown */}
                  <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Mailchimp audience</p>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">New contacts added</span>
                    <span className="text-green-400 font-medium">{pushResult.audience_added.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Existing — profile updated</span>
                    <span className="text-gray-300">{pushResult.audience_updated.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Existing — no change</span>
                    <span className="text-gray-300">{pushResult.audience_unchanged.toLocaleString()}</span>
                  </div>
                  {pushResult.audience_skipped > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-yellow-500">Unsubscribed / bounced (cannot re-add)</span>
                      <span className="text-yellow-400">{pushResult.audience_skipped}</span>
                    </div>
                  )}
                  {pushResult.audience_errored > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-red-400">Import errors</span>
                      <span className="text-red-400">{pushResult.audience_errored}</span>
                    </div>
                  )}
                  <div className="h-px bg-gray-700" />
                  {/* Tag breakdown */}
                  <p className="text-xs text-gray-500 uppercase tracking-wide font-medium pt-1">Tag</p>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Tag applied</span>
                    <span className="text-green-400 font-medium">{pushResult.tagged.toLocaleString()}</span>
                  </div>
                  {pushResult.not_taggable > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-yellow-500">Could not be tagged (unsubscribed / bounced)</span>
                      <span className="text-yellow-400">{pushResult.not_taggable}</span>
                    </div>
                  )}
                  <div className="h-px bg-gray-700" />
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>Total processed</span>
                    <span>{pushResult.total.toLocaleString()}</span>
                  </div>
                </div>
                {pushResult.errors.length > 0 && (
                  <div className="mb-4 text-red-400 text-xs space-y-0.5 max-h-20 overflow-y-auto bg-gray-800 rounded px-2 py-2">
                    {pushResult.errors.slice(0, 10).map((e, i) => (
                      <div key={i}>{e.email}: {e.error}</div>
                    ))}
                    {pushResult.errors.length > 10 && <div>…and {pushResult.errors.length - 10} more</div>}
                  </div>
                )}
                <div className="flex justify-end">
                  <button onClick={handleDismissResult} className="bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium px-4 py-2 rounded transition-colors">
                    Done
                  </button>
                </div>
              </>
            )}

            {/* ── Error state ── */}
            {!pushing && pushError && (
              <>
                <h2 className="text-base font-semibold text-white mb-3">Push failed</h2>
                <p className="text-red-400 text-sm mb-5">{pushError}</p>
                <div className="flex justify-end">
                  <button onClick={handleDismissResult} className="bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium px-4 py-2 rounded transition-colors">
                    Close
                  </button>
                </div>
              </>
            )}

            {/* ── Confirm state ── */}
            {!pushing && !pushResult && !pushError && (
              <>
                <h2 className="text-lg font-semibold text-white mb-3">Confirm Push</h2>
                <p className="text-gray-300 text-sm mb-2">
                  Push to Mailchimp with tag <strong>&apos;{tag}&apos;</strong>?
                </p>
                <div className="bg-gray-800 rounded px-3 py-2 text-sm mb-6 space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Selected</span>
                    <span className="text-white font-medium">{effectiveCount.toLocaleString()}</span>
                  </div>
                  {selectAllMatching ? (
                    <div className="text-xs text-gray-500 pt-1">
                      All contacts matching your filters (across every page). The email / SMS-only split is
                      computed during the push.
                    </div>
                  ) : (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Email contacts</span>
                        <span className="text-green-400 font-medium">{selectedWithEmail}</span>
                      </div>
                      {selectedSmsOnly > 0 && (
                        <div className="flex justify-between">
                          <span className="text-gray-400">SMS-only (placeholder email)</span>
                          <span className="text-gray-300 font-medium">{selectedSmsOnly}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="flex gap-3 justify-end">
                  <button
                    onClick={handleDismissResult}
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
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
