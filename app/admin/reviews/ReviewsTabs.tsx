'use client'

import { useCallback, useEffect, useState } from 'react'
import ReviewsClient from './ReviewsClient'
import CsatTab from './CsatTab'
import ReputationSettingsTab, { type Props as ReputationProps } from './ReputationSettingsTab'
import type { CsatRow } from '@/lib/csat/metrics'
import type { CsatSettings } from '@/lib/csat/config'

interface Tech { id: string; full_name: string }
interface GoogleKpi { total: number; avgRating: number | null; fiveStars: number; oneStar: number }
interface LastRun { status: string; ended_at: string | null; reviews_new: number | null; reviews_seen: number | null; errors_json: string[] | null }

interface Props {
  csat: { settings: CsatSettings; rows: CsatRow[] }
  google: { kpi: GoogleKpi; lastRun: LastRun | null; needsApproval: number; backlogCap: number }
  techs: Tech[]
  reputation: ReputationProps
}

type Sub = 'csat' | 'google' | 'settings'

// Reviews tab shell. CSAT is the primary/default sub-tab; the existing Google
// reviews UI lives under the second. Deep-linked via ?sub=csat|google.
export default function ReviewsTabs({ csat, google, techs, reputation }: Props) {
  const [sub, setSub] = useState<Sub>('csat')
  const [needsApproval, setNeedsApproval] = useState(google.needsApproval)
  const onNeedsApproval = useCallback((n: number) => setNeedsApproval(n), [])
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('sub')
    if (s === 'google' || s === 'csat' || s === 'settings') setSub(s)
  }, [])

  function select(next: Sub) {
    setSub(next)
    const url = new URL(window.location.href)
    url.searchParams.set('sub', next)
    window.history.replaceState(null, '', url.toString())
  }

  const TABS: { key: Sub; label: string; count?: number }[] = [
    { key: 'csat', label: 'CSAT' },
    { key: 'google', label: 'Google Reviews', count: needsApproval },
    { key: 'settings', label: 'Settings' },
  ]

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 border-b border-gray-200 mb-6">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => select(t.key)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${sub === t.key ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t.label}
            {t.count != null && t.count > 0 && <span className="ml-1.5 inline-block min-w-[1.25rem] px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[11px] font-semibold leading-none text-center" title="Replies waiting for approval">{t.count}</span>}
          </button>
        ))}
      </div>

      {sub === 'csat' && <CsatTab settings={csat.settings} rows={csat.rows} techs={techs} />}
      {sub === 'google' && <ReviewsClient kpi={google.kpi} lastRun={google.lastRun} techs={techs} backlogCap={google.backlogCap} onNeedsApproval={onNeedsApproval} />}
      {sub === 'settings' && <ReputationSettingsTab {...reputation} />}
    </div>
  )
}
