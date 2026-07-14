'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { formatMoney } from '@/lib/week'
import { listPeriods, periodForRecognitionDate } from '@/lib/commission/periods'

interface SalesRow { rank: number; tech_name: string; dollars_sold: number; dollars_received: number }
interface ReviewRow { techName: string; total: number; avg: number; s5: number; s4: number; s3: number; s2: number; s1: number }

export default function LeaderboardClient({
  todayStr,
  highlightName,
  reviewsHref,
}: {
  todayStr: string
  highlightName?: string
  /** Where the "View all reviews" button links (admin vs tech reviews page). */
  reviewsHref: string
}) {
  const periods = useMemo(() => listPeriods(todayStr).reverse(), [todayStr])
  const current = useMemo(() => periodForRecognitionDate(todayStr) ?? periods[0], [todayStr, periods])
  const [periodKey, setPeriodKey] = useState(current?.key ?? periods[0]?.key)
  const period = useMemo(() => periods.find(p => p.key === periodKey), [periods, periodKey])

  const [sales, setSales] = useState<SalesRow[]>([])
  const [reviews, setReviews] = useState<ReviewRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!period) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const qs = `period_start=${period.start}&period_end=${period.end}`
      const [salesRes, reviewsRes] = await Promise.all([
        fetch(`/api/commission/leaderboard?${qs}`),
        fetch(`/api/reviews/leaderboard?${qs}`),
      ])
      const salesData = await salesRes.json()
      const reviewsData = await reviewsRes.json()
      if (!salesRes.ok) throw new Error(salesData.error || 'Failed to load sales')
      if (!reviewsRes.ok) throw new Error(reviewsData.error || 'Failed to load reviews')
      setSales(salesData.rows)
      setReviews(reviewsData.rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2">
        <label className="text-sm text-gray-600">Period</label>
        <select
          value={periodKey}
          onChange={e => setPeriodKey(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400"
        >
          {periods.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">{error}</div>
      )}

      {/* Sales */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">Sales</h2>
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-600 w-12">#</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Technician</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Dollars Sold</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Dollars Received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
                ) : sales.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">No sales this period yet.</td></tr>
                ) : sales.map(r => {
                  const mine = highlightName && r.tech_name === highlightName
                  return (
                    <tr key={r.rank} className={mine ? 'bg-red-50' : ''}>
                      <td className="px-4 py-2 text-gray-500 font-medium">{r.rank}</td>
                      <td className="px-4 py-2 text-gray-900 font-medium">
                        {r.tech_name}{mine && <span className="ml-2 text-xs text-red-500">you</span>}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-900 font-semibold">{formatMoney(r.dollars_sold)}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{formatMoney(r.dollars_received)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs text-gray-400">
          <span className="font-medium">Dollars sold</span> = the full value of every job sold (created) this
          period, regardless of its current stage — scheduled, completed, invoiced, or paid.
          <span className="font-medium"> Dollars received</span> = the portion of those sold jobs the customer has
          paid. Commission is figured separately by <span className="font-medium">completion date</span>, so these
          totals won&rsquo;t match the Commission tab&rsquo;s detail — that&rsquo;s expected.
        </p>
      </section>

      {/* Reviews */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-700">Reviews</h2>
          <Link
            href={reviewsHref}
            className="text-xs px-3 py-1.5 rounded border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 font-medium"
          >
            View all reviews →
          </Link>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-600 w-12">#</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Technician</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">Reviews</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">Avg ★</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">5★</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">4★</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">3★</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">2★</th>
                  <th className="text-right px-3 py-3 font-medium text-gray-600">1★</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
                ) : reviews.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-400">No reviews this period yet.</td></tr>
                ) : reviews.map((r, i) => {
                  const mine = highlightName && r.techName === highlightName
                  const cell = (n: number) => (n > 0 ? n : <span className="text-gray-300">–</span>)
                  return (
                    <tr key={r.techName} className={mine ? 'bg-red-50' : ''}>
                      <td className="px-4 py-2 text-gray-500 font-medium">{i + 1}</td>
                      <td className="px-4 py-2 text-gray-900 font-medium">
                        {r.techName}{mine && <span className="ml-2 text-xs text-red-500">you</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-900 font-semibold">{r.total}</td>
                      <td className="px-3 py-2 text-right text-gray-700">{r.avg ? r.avg.toFixed(1) : '–'}</td>
                      <td className="px-3 py-2 text-right text-gray-600">{cell(r.s5)}</td>
                      <td className="px-3 py-2 text-right text-gray-600">{cell(r.s4)}</td>
                      <td className="px-3 py-2 text-right text-gray-600">{cell(r.s3)}</td>
                      <td className="px-3 py-2 text-right text-gray-600">{cell(r.s2)}</td>
                      <td className="px-3 py-2 text-right text-gray-600">{cell(r.s1)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs text-gray-400">
          Reviews matched to each tech&rsquo;s jobs this period. Tap &ldquo;View all reviews&rdquo; to read them.
        </p>
      </section>
    </div>
  )
}
