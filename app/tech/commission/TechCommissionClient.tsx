'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import CommissionDetailPanel from '@/components/CommissionDetailPanel'
import type { TechPeriodDetail } from '@/lib/commission/detail'
import { listPeriods, periodForRecognitionDate } from '@/lib/commission/periods'

export default function TechCommissionClient({ todayStr }: { todayStr: string }) {
  const periods = useMemo(() => listPeriods(todayStr).reverse(), [todayStr])
  const current = useMemo(() => periodForRecognitionDate(todayStr) ?? periods[0], [todayStr, periods])
  const [periodKey, setPeriodKey] = useState(current?.key ?? periods[0]?.key)
  const period = useMemo(() => periods.find(p => p.key === periodKey), [periods, periodKey])

  const [detail, setDetail] = useState<TechPeriodDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!period) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/tech/commission?period_start=${period.start}&period_end=${period.end}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setDetail(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
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

      {loading ? (
        <div className="text-center text-gray-400 py-10">Loading…</div>
      ) : detail ? (
        <CommissionDetailPanel detail={detail} />
      ) : null}
    </div>
  )
}
