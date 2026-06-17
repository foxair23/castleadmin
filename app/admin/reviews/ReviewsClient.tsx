'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'

const ReviewsCharts = dynamic(() => import('./ReviewsCharts'), { ssr: false })

// ── Types ─────────────────────────────────────────────────────────────────────

interface Review {
  id: string
  google_review_id: string
  reviewer_name: string | null
  star_rating: number
  comment: string | null
  created_at_google: string
  reply_text: string | null
  match_status: string
  match_score: number | null
  match_confidence: string | null
  matched_customer_id: string | null
  matched_job_id: string | null
  matched_customer_name: string | null
  matched_tech_name: string | null
}

interface Customer {
  id: string
  customer_name: string
  last_serviced_date: string | null
}

interface KPI {
  total: number
  avgRating: number | null
  fiveStars: number
  oneStar: number
}

interface LastRun {
  status: string
  ended_at: string | null
  reviews_new: number | null
  reviews_seen: number | null
}

interface Props {
  kpi: KPI
  lastRun: LastRun | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${rating} stars`}>
      {[1, 2, 3, 4, 5].map(n => (
        <svg key={n} className={`h-4 w-4 ${n <= rating ? 'text-yellow-400' : 'text-gray-200'}`} fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </span>
  )
}

function MatchBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    auto:           'bg-green-100 text-green-700',
    confirmed:      'bg-green-100 text-green-700',
    pending_review: 'bg-amber-100 text-amber-700',
    skipped:        'bg-gray-100 text-gray-500',
    anonymous:      'bg-gray-100 text-gray-500',
  }
  const labels: Record<string, string> = {
    auto:           'Auto-matched',
    confirmed:      'Confirmed',
    pending_review: 'Pending',
    skipped:        'Skipped',
    anonymous:      'Anonymous',
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] ?? 'bg-gray-100 text-gray-500'}`}>
      {labels[status] ?? status}
    </span>
  )
}

function MatchCellInner({
  review,
  onAction,
  onSearch,
}: {
  review: Review
  onAction: (id: string, action: 'confirm' | 'skip' | 'unmatch') => void
  onSearch: (review: Review) => void
}) {
  const { match_status, matched_customer_id, matched_customer_name, id } = review

  if (match_status === 'anonymous' || match_status === 'skipped') {
    return null
  }

  if (match_status === 'confirmed' || match_status === 'auto') {
    return (
      <span className="inline-flex items-center gap-1">
        {matched_customer_name && (
          <span className="text-xs text-gray-500">{matched_customer_name}</span>
        )}
        <button
          onClick={() => onAction(id, 'unmatch')}
          title="Unmatch"
          className="text-gray-300 hover:text-red-400 transition-colors leading-none"
        >
          ✕
        </button>
      </span>
    )
  }

  // pending_review
  return (
    <div className="flex flex-col gap-1">
      {matched_customer_name && (
        <span className="text-xs text-gray-500">{matched_customer_name}</span>
      )}
      <div className="flex gap-1.5 flex-wrap">
        {matched_customer_id && (
          <button
            onClick={() => onAction(id, 'confirm')}
            className="text-xs px-2 py-0.5 rounded border border-green-300 text-green-700 hover:bg-green-50"
          >
            Confirm
          </button>
        )}
        <button
          onClick={() => onSearch(review)}
          className="text-xs px-2 py-0.5 rounded border border-blue-300 text-blue-600 hover:bg-blue-50"
        >
          Search
        </button>
        <button
          onClick={() => onAction(id, 'skip')}
          className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-50"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

// ── Manual match modal ────────────────────────────────────────────────────────

function ManualMatchModal({
  review,
  onClose,
  onMatched,
}: {
  review: Review
  onClose: () => void
  onMatched: () => void
}) {
  const [query, setQuery]         = useState('')
  const [results, setResults]     = useState<Customer[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving]       = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim().length < 2) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/admin/customers/search?q=${encodeURIComponent(query.trim())}`)
        const json = await res.json()
        setResults(json.customers ?? [])
      } finally {
        setSearching(false)
      }
    }, 250)
  }, [query])

  async function selectCustomer(customer: Customer) {
    setSaving(customer.id)
    await fetch(`/api/admin/reviews/${review.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'manual', customerId: customer.id }),
    })
    setSaving(null)
    onMatched()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100">
          <p className="text-xs text-gray-500 mb-0.5">Matching review by</p>
          <p className="font-semibold text-gray-900">{review.reviewer_name ?? 'Anonymous'}</p>
          {review.comment && (
            <p className="text-xs text-gray-400 mt-1 line-clamp-2">{review.comment}</p>
          )}
        </div>

        <div className="px-5 py-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search customer name…"
            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="max-h-64 overflow-y-auto divide-y divide-gray-50">
          {searching && (
            <div className="px-5 py-3 text-sm text-gray-400">Searching…</div>
          )}
          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <div className="px-5 py-3 text-sm text-gray-400">No customers found</div>
          )}
          {results.map(c => (
            <button
              key={c.id}
              onClick={() => selectCustomer(c)}
              disabled={saving === c.id}
              className="w-full text-left px-5 py-3 hover:bg-blue-50 disabled:opacity-50 transition-colors"
            >
              <span className="text-sm text-gray-800">{c.customer_name}</span>
              {c.last_serviced_date && (
                <span className="ml-2 text-xs text-gray-400">
                  Last service: {new Date(c.last_serviced_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex justify-end">
          <button
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Review detail modal ───────────────────────────────────────────────────────

function ReviewDetailModal({
  review,
  onClose,
  onAction,
  onSearch,
}: {
  review: Review
  onClose: () => void
  onAction: (id: string, action: 'confirm' | 'skip' | 'unmatch') => void
  onSearch: (review: Review) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <p className="font-semibold text-gray-900 text-base">
              {review.reviewer_name ?? <span className="italic text-gray-400">Anonymous</span>}
            </p>
            <div className="flex items-center gap-3 mt-1">
              <Stars rating={review.star_rating} />
              <span className="text-xs text-gray-400">{fmtDate(review.created_at_google)}</span>
              <MatchBadge status={review.match_status} />
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none mt-0.5">✕</button>
        </div>

        {/* Comment */}
        <div className="px-6 py-4 border-b border-gray-100">
          {review.comment
            ? <p className="text-sm text-gray-700 leading-relaxed">{review.comment}</p>
            : <p className="text-sm text-gray-400 italic">No comment</p>
          }
        </div>

        {/* Match info + actions */}
        <div className="px-6 py-4">
          {(review.match_status === 'confirmed' || review.match_status === 'auto') && review.matched_customer_name && (
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Matched customer</p>
                <p className="text-sm font-medium text-gray-900">{review.matched_customer_name}</p>
                {review.matched_tech_name && (
                  <p className="text-xs text-gray-400 mt-1">Tech: {review.matched_tech_name}</p>
                )}
              </div>
              <button
                onClick={() => { onAction(review.id, 'unmatch'); onClose() }}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors"
              >
                Unmatch
              </button>
            </div>
          )}

          {review.match_status === 'pending_review' && (
            <div>
              {review.matched_customer_name && (
                <div className="mb-3">
                  <p className="text-xs text-gray-500 mb-0.5">Suggested match</p>
                  <p className="text-sm font-medium text-gray-900">{review.matched_customer_name}</p>
                  {review.match_score != null && (
                    <p className="text-xs text-gray-400">Confidence: {Math.round(review.match_score * 100)}%</p>
                  )}
                </div>
              )}
              <div className="flex gap-2 flex-wrap">
                {review.matched_customer_id && (
                  <button
                    onClick={() => { onAction(review.id, 'confirm'); onClose() }}
                    className="text-sm px-3 py-1.5 rounded border border-green-300 text-green-700 hover:bg-green-50"
                  >
                    Confirm Match
                  </button>
                )}
                <button
                  onClick={() => { onClose(); onSearch(review) }}
                  className="text-sm px-3 py-1.5 rounded border border-blue-300 text-blue-600 hover:bg-blue-50"
                >
                  Search Customer
                </button>
                <button
                  onClick={() => { onAction(review.id, 'skip'); onClose() }}
                  className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-50"
                >
                  Skip
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ReviewsClient({ kpi, lastRun }: Props) {
  const [reviews, setReviews]   = useState<Review[]>([])
  const [total, setTotal]       = useState(0)
  const [page, setPage]         = useState(1)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  // Filters
  const [stars, setStars]       = useState<string>('')
  const [status, setStatus]     = useState<string>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')

  // Sync + matching
  const [matchingStatus, setMatchingStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [matchResult, setMatchResult]       = useState<{ reviewsNew: number; reviewsUpdated: number; matched: number; candidates: number; noMatch: number } | null>(null)

  // Tab
  const [tab, setTab] = useState<'list' | 'charts'>('list')

  // Detail modal
  const [detailReview, setDetailReview] = useState<Review | null>(null)

  // Manual match modal
  const [searchTarget, setSearchTarget] = useState<Review | null>(null)

  const pageSize   = 25
  const totalPages = Math.ceil(total / pageSize)

  const load = useCallback(async (p: number) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(p) })
      if (stars)                      params.set('stars', stars)
      if (status && status !== 'all') params.set('status', status)
      if (dateFrom)                   params.set('date_from', dateFrom)
      if (dateTo)                     params.set('date_to', dateTo)

      const res = await fetch(`/api/admin/reviews?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setReviews(json.reviews)
      setTotal(json.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reviews')
    } finally {
      setLoading(false)
    }
  }, [stars, status, dateFrom, dateTo])

  useEffect(() => { setPage(1) }, [stars, status, dateFrom, dateTo])
  useEffect(() => { load(page) }, [load, page])

  async function runSyncAndMatch() {
    setMatchingStatus('running')
    setMatchResult(null)
    try {
      const res = await fetch('/api/admin/reviews/run-matching', { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setMatchResult({ reviewsNew: json.reviewsNew, reviewsUpdated: json.reviewsUpdated, matched: json.matched, candidates: json.candidates, noMatch: json.noMatch })
      setMatchingStatus('done')
      load(page)
    } catch {
      setMatchingStatus('error')
    }
  }

  async function handleAction(reviewId: string, action: 'confirm' | 'skip' | 'unmatch') {
    await fetch(`/api/admin/reviews/${reviewId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    load(page)
  }

  const pct = (n: number) => kpi.total > 0 ? Math.round(n / kpi.total * 100) : 0

  return (
    <div className="space-y-6">

      {/* Detail modal */}
      {detailReview && (
        <ReviewDetailModal
          review={detailReview}
          onClose={() => setDetailReview(null)}
          onAction={(id, action) => { handleAction(id, action); setDetailReview(null) }}
          onSearch={(r) => { setDetailReview(null); setSearchTarget(r) }}
        />
      )}

      {/* Manual match modal */}
      {searchTarget && (
        <ManualMatchModal
          review={searchTarget}
          onClose={() => setSearchTarget(null)}
          onMatched={() => { setSearchTarget(null); load(page) }}
        />
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-900 mr-auto">Google Reviews</h1>
        {lastRun && (
          <span className="text-xs text-gray-400">
            Last sync: {lastRun.ended_at ? fmtDate(lastRun.ended_at) : '—'}
            {lastRun.reviews_new != null && lastRun.reviews_new > 0 && (
              <span className="ml-1 text-green-600">+{lastRun.reviews_new} new</span>
            )}
          </span>
        )}
        <button
          onClick={runSyncAndMatch}
          disabled={matchingStatus === 'running'}
          className="text-sm px-3 py-1.5 rounded border border-red-300 bg-red-50 hover:bg-red-100 disabled:opacity-50 text-red-700"
        >
          {matchingStatus === 'running' ? 'Syncing…' : 'Sync & Match Reviews'}
        </button>
        {matchingStatus === 'done' && matchResult && (
          <span className="text-xs text-gray-500">
            +{matchResult.reviewsNew} new · {matchResult.matched} auto-matched · {matchResult.candidates} candidates
          </span>
        )}
        {matchingStatus === 'error' && (
          <span className="text-xs text-red-500">Matching failed</span>
        )}
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Total Reviews</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{kpi.total.toLocaleString()}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Avg Rating</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            {kpi.avgRating != null ? kpi.avgRating.toFixed(1) : '—'}
          </p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">5-Star</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{kpi.fiveStars.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{pct(kpi.fiveStars)}% of total</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">1-Star</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{kpi.oneStar.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{pct(kpi.oneStar)}% of total</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {(['list', 'charts'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? 'text-gray-900 border-b-2 border-red-500 -mb-px'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'list' ? 'Reviews' : 'Charts & Leaderboard'}
          </button>
        ))}
      </div>

      {tab === 'charts' && <ReviewsCharts />}

      {tab === 'list' && <>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Stars</label>
          <select
            value={stars}
            onChange={e => setStars(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-2 py-1.5 text-gray-900 bg-white"
          >
            <option value="">All ratings</option>
            <option value="5">5 ★</option>
            <option value="4">4 ★</option>
            <option value="3">3 ★</option>
            <option value="2">2 ★</option>
            <option value="1">1 ★</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Match status</label>
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-2 py-1.5 text-gray-900 bg-white"
          >
            <option value="all">All statuses</option>
            <option value="pending_review">Pending</option>
            <option value="auto">Auto-matched</option>
            <option value="confirmed">Confirmed</option>
            <option value="anonymous">Anonymous</option>
            <option value="skipped">Skipped</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-2 py-1.5 text-gray-900"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-2 py-1.5 text-gray-900"
          />
        </div>
        {(stars || status !== 'all' || dateFrom || dateTo) && (
          <button
            onClick={() => { setStars(''); setStatus('all'); setDateFrom(''); setDateTo('') }}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Reviews table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {error && (
          <div className="p-4 text-sm text-red-600">{error}</div>
        )}
        {loading && !error && (
          <div className="p-8 text-center text-sm text-gray-400">Loading…</div>
        )}
        {!loading && !error && reviews.length === 0 && (
          <div className="p-8 text-center text-sm text-gray-400">
            No reviews found.
            {kpi.total === 0 && (
              <span className="block mt-1 text-gray-400">
                Reviews are ingested daily. Run the cron manually or wait for the next scheduled run.
              </span>
            )}
          </div>
        )}
        {!loading && reviews.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Reviewer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Rating</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Comment</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Match</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tech</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {reviews.map(r => (
                <tr key={r.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setDetailReview(r)}>
                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                    {r.reviewer_name ?? <span className="text-gray-400 italic">Anonymous</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Stars rating={r.star_rating} />
                  </td>
                  <td className="px-4 py-3 text-gray-600 max-w-sm">
                    {r.comment
                      ? <span title={r.comment}>{r.comment.slice(0, 120)}{r.comment.length > 120 ? '…' : ''}</span>
                      : <span className="text-gray-400 italic">No comment</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {fmtDate(r.created_at_google)}
                  </td>
                  <td className="px-4 py-3">
                    <MatchBadge status={r.match_status} />
                  </td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <MatchCellInner review={r} onAction={handleAction} onSearch={setSearchTarget} />
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {r.matched_tech_name ?? <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>{total.toLocaleString()} review{total !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
            >
              ← Prev
            </button>
            <span>Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      </>}

    </div>
  )
}
