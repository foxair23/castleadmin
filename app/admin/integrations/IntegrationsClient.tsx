'use client'

import { useState } from 'react'
import SFConnectionClient from '../sf/SFConnectionClient'
import SfSyncClient from '../sf-sync/SfSyncClient'
import MailchimpClient from '../mailchimp/MailchimpClient'

interface AppTech {
  id: string
  full_name: string
  is_active: boolean
  sf_technician_id: string | null
}

interface SyncRun {
  entity: string
  run_type: string
  status: string
  started_at: string
  completed_at: string | null
  records_upserted: number
  pages_fetched: number
  last_page: number | null
  error_message: string | null
}

interface PushLogRow {
  id: string
  pushed_at: string
  tag: string
  contact_count: number
  added_count: number
  updated_count: number
  skipped_count: number
  failed_count: number
}

interface Props {
  techs: AppTech[]
  runs: SyncRun[]
  counts: Record<string, number>
  pushLog: PushLogRow[]
  serverPrefix: string
}

type Tab = 'service-fusion' | 'mailchimp'

export default function IntegrationsClient({ techs, runs, counts, pushLog, serverPrefix }: Props) {
  const [tab, setTab] = useState<Tab>('service-fusion')

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-5">Integrations</h1>

      <div className="flex gap-1 mb-6 border-b border-gray-200">
        <TabButton active={tab === 'service-fusion'} onClick={() => setTab('service-fusion')}>
          Service Fusion
        </TabButton>
        <TabButton active={tab === 'mailchimp'} onClick={() => setTab('mailchimp')}>
          Mailchimp
        </TabButton>
      </div>

      {tab === 'service-fusion' && (
        <div className="space-y-10">
          <SfSyncClient runs={runs} counts={counts} />
          <div className="border-t border-gray-200 pt-8">
            <SFConnectionClient initialTechs={techs} />
          </div>
        </div>
      )}

      {tab === 'mailchimp' && (
        <MailchimpClient pushLog={pushLog} serverPrefix={serverPrefix} />
      )}
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-red-600 text-red-600'
          : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {children}
    </button>
  )
}
