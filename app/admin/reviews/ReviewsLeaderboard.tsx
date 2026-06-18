'use client'

import { useState, useEffect, useCallback } from 'react'

interface LeaderboardRow {
  techName: string
  total: number
  s5: number
  s4: number
  s3: number
  s2: number
  s1: number
}

function getMondayUTC(): string {
  const now = new Date()
  const day = now.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() + diff)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function shiftWeek(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n * 7)
  return d.toISOString().slice(0, 10)
}

function fmtWeekRange(start: string, end: string): string {
  const s = new Date(start + 'T00:00:00Z')
  const e = new Date(end   + 'T00:00:00Z')
  const mo = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const yr = e.getUTCFullYear()
  return `${mo(s)} – ${mo(e)}, ${yr}`
}

function StarCell({ n, color }: { n: number; color: string }) {
  if (n === 0) return <span className="text-gray-200">–</span>
  return <span className={color}>{n}</span>
}

export default function ReviewsLeaderboard() {
  const currentMonday = getMondayUTC()
  const [weekStart, setWeekStart] = useState(currentMonday)
  const [weekEnd,   setWeekEnd]   = useState('')
  const [rows,      setRows]      = useState<LeaderboardRow[]>([])
  const [loading,   setLoading]   = useState(true)

  const load = useCallback((ws: string) => {
    setLoading(true)
    fetch(`/api/admin/reviews/leaderboard?weekStart=${ws}`)
      .then(r => r.json())
      .then(d => { setRows(d.rows ?? []); setWeekEnd(d.weekEnd ?? '') })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(weekStart) }, [weekStart, load])

  const canGoForward = weekStart < currentMonday

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Weekly Tech Leaderboard</h2>
          <p className="text-xs text-gray-400 mt-0.5">Matched &amp; confirmed reviews · Mon–Sun</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWeekStart(ws => shiftWeek(ws, -1))}
            className="px-2.5 py-1.5 text-xs text-gray-600 border border-gray-200 rounded hover:bg-gray-50 transition-colors"
          >
            ← Prev
          </button>
          <span className="text-xs font-medium text-gray-700 min-w-[160px] text-center">
            {weekEnd ? fmtWeekRange(weekStart, weekEnd) : '…'}
          </span>
          <button
            onClick={() => setWeekStart(ws => shiftWeek(ws, 1))}
            disabled={!canGoForward}
            className="px-2.5 py-1.5 text-xs text-gray-600 border border-gray-200 rounded hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next →
          </button>
          {weekStart !== currentMonday && (
            <button
              onClick={() => setWeekStart(currentMonday)}
              className="px-2.5 py-1.5 text-xs text-blue-600 border border-blue-200 rounded hover:bg-blue-50 transition-colors"
            >
              This week
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-gray-400">No matched reviews this week.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left pl-5 pr-2 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">#</th>
                <th className="text-left px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Technician</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-700 uppercase tracking-wide">Total</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-yellow-500 uppercase tracking-wide">5 ★</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">4 ★</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">3 ★</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-orange-400 uppercase tracking-wide">2 ★</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-red-500 uppercase tracking-wide">1 ★</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row, i) => {
                const avgRating = row.total > 0
                  ? (row.s5 * 5 + row.s4 * 4 + row.s3 * 3 + row.s2 * 2 + row.s1) / row.total
                  : 0
                const rank = i + 1
                return (
                  <tr key={row.techName} className="hover:bg-gray-50">
                    <td className="pl-5 pr-2 py-3">
                      <span className={`text-xs font-bold ${rank === 1 ? 'text-yellow-500' : rank === 2 ? 'text-gray-400' : rank === 3 ? 'text-amber-600' : 'text-gray-300'}`}>
                        #{rank}
                      </span>
                    </td>
                    <td className="px-3 py-3 font-medium text-gray-900">{row.techName}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-bold text-gray-900">{row.total}</span>
                      <span className={`ml-1.5 text-xs font-medium ${avgRating >= 4.5 ? 'text-green-600' : avgRating >= 3.5 ? 'text-gray-500' : 'text-red-500'}`}>
                        ({avgRating.toFixed(1)}★)
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium"><StarCell n={row.s5} color="text-yellow-500" /></td>
                    <td className="px-4 py-3 text-right font-medium"><StarCell n={row.s4} color="text-gray-700" /></td>
                    <td className="px-4 py-3 text-right font-medium"><StarCell n={row.s3} color="text-gray-500" /></td>
                    <td className="px-4 py-3 text-right font-medium"><StarCell n={row.s2} color="text-orange-500" /></td>
                    <td className="px-4 py-3 text-right font-medium"><StarCell n={row.s1} color="text-red-500" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
