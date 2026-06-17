'use client'

import { useState, useEffect, useCallback } from 'react'

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
  matched_customer_id: string | null
  matched_job_id: string | null
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
  const [stars, setStars]   = useState<string>('')      // '' = all, or '1', '5', etc.
  const [status, setStatus] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')

  const pageSize = 25
  const totalPages = Math.ceil(total / pageSize)

  const load = useCallback(async (p: number) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(p) })
      if (stars)    params.set('stars', stars)
      if (status && status !== 'all') params.set('status', status)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo)   params.set('date_to', dateTo)

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

  const pct = (n: number) => kpi.total > 0 ? Math.round(n / kpi.total * 100) : 0

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Google Reviews</h1>
        {lastRun && (
          <span className="text-xs text-gray-400">
            Last sync: {lastRun.ended_at ? fmtDate(lastRun.ended_at) : '—'}
            {lastRun.reviews_new != null && lastRun.reviews_new > 0 && (
              <span className="ml-1 text-green-600">+{lastRun.reviews_new} new</span>
            )}
          </span>
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
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {reviews.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
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

    </div>
  )
}
