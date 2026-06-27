'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import CommissionDetailPanel from '@/components/CommissionDetailPanel'
import type { TechPeriodDetail } from '@/lib/commission/detail'
import { listPeriods, periodForRecognitionDate } from '@/lib/commission/periods'

interface Tech { id: string; full_name: string }

export default function AdminTechDetailClient({ techs, todayStr }: { techs: Tech[]; todayStr: string }) {
  const searchParams = useSearchParams()
  const periods = useMemo(() => listPeriods(todayStr).reverse(), [todayStr])
  const current = useMemo(() => periodForRecognitionDate(todayStr) ?? periods[0], [todayStr, periods])

  // Drill-down support: ?tech=&period= (period = period key).
  const initialTech = searchParams.get('tech') ?? techs[0]?.id ?? ''
  const initialPeriodKey = searchParams.get('period') ?? current?.key ?? periods[0]?.key

  const [techId, setTechId] = useState(initialTech)
  const [periodKey, setPeriodKey] = useState(initialPeriodKey)
  const period = useMemo(() => periods.find(p => p.key === periodKey), [periods, periodKey])

  const [detail, setDetail] = useState<TechPeriodDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!period || !techId) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/commission/detail?tech_user_id=${techId}&period_start=${period.start}&period_end=${period.end}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setDetail(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [period, techId])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Technician</label>
          <select
            value={techId}
            onChange={e => setTechId(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            {techs.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
          </select>
        </div>
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
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">{error}</div>
      )}

      {loading ? (
        <div className="text-center text-gray-400 py-10">Loading…</div>
      ) : techs.length === 0 ? (
        <div className="text-center text-gray-400 py-10">No active technicians.</div>
      ) : detail ? (
        <CommissionDetailPanel detail={detail} />
      ) : null}
    </div>
  )
}
