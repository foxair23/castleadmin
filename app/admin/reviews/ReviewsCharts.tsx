'use client'

import { useState, useEffect } from 'react'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import ReviewsLeaderboard from './ReviewsLeaderboard'

interface MonthlyPoint {
  month: string
  count: number
  avg_rating: number | null
}

interface TechRow {
  name: string
  reviews: number
  avgRating: number
}

export default function ReviewsCharts() {
  const [monthly, setMonthly]           = useState<MonthlyPoint[]>([])
  const [techLeaderboard, setTechLeaderboard] = useState<TechRow[]>([])
  const [loading, setLoading]           = useState(true)

  useEffect(() => {
    fetch('/api/admin/reviews/charts')
      .then(r => r.json())
      .then(d => { setMonthly(d.monthly ?? []); setTechLeaderboard(d.techLeaderboard ?? []) })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="py-8 text-center text-sm text-gray-400">Loading charts…</div>

  return (
    <div className="space-y-8">

      {/* Rating trend */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Reviews per Month</h2>
        {monthly.length === 0 ? (
          <p className="text-sm text-gray-400">No data yet.</p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthly} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} width={28} allowDecimals={false} />
                <Tooltip
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(v: any) => [v, 'Reviews']}
                />
                <Bar dataKey="count" fill="#dc2626" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Avg rating trend */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Avg Rating by Month</h2>
        {monthly.length === 0 ? (
          <p className="text-sm text-gray-400">No data yet.</p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={monthly} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} width={28} domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Tooltip formatter={(v: any) => [typeof v === 'number' ? v.toFixed(1) : v, 'Avg Rating']} />
                <Line
                  type="monotone"
                  dataKey="avg_rating"
                  stroke="#dc2626"
                  strokeWidth={1.5}
                  dot={{ r: 3, fill: '#dc2626' }}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Weekly tech leaderboard */}
      <ReviewsLeaderboard />

      {/* All-time tech leaderboard */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">All-Time Tech Leaderboard</h2>
          <p className="text-xs text-gray-400 mt-0.5">Matched &amp; confirmed reviews, top 15</p>
        </div>
        {techLeaderboard.length === 0 ? (
          <p className="px-5 py-4 text-sm text-gray-400">No matched reviews yet. Run matching first.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Technician</th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Reviews</th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Avg Rating</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {techLeaderboard.map((t, i) => (
                <tr key={t.name} className="hover:bg-gray-50">
                  <td className="px-5 py-3 text-gray-900 flex items-center gap-2">
                    {i < 3 && (
                      <span className={`text-xs font-bold ${i === 0 ? 'text-yellow-500' : i === 1 ? 'text-gray-400' : 'text-amber-600'}`}>
                        #{i + 1}
                      </span>
                    )}
                    {i >= 3 && <span className="text-xs text-gray-400 w-5">{i + 1}</span>}
                    {t.name}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-700 font-medium">{t.reviews}</td>
                  <td className="px-5 py-3 text-right">
                    <span className={`font-medium ${t.avgRating >= 4.5 ? 'text-green-600' : t.avgRating >= 3.5 ? 'text-gray-700' : 'text-red-500'}`}>
                      {t.avgRating.toFixed(1)} ★
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  )
}
