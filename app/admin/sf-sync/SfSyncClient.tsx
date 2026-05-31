'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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

interface Props {
  runs: SyncRun[]
  counts: Record<string, number>
}

const COUNT_LABELS: Record<string, string> = {
  sf_customers: 'Customers',
  sf_jobs: 'Jobs',
  sf_estimates: 'Estimates',
  sf_invoices: 'Invoices',
  sf_calendar_tasks: 'Calendar Tasks',
  sf_techs: 'Technicians',
  sf_customer_equipment: 'Equipment',
}

const SYNC_ENTITIES = ['jobs', 'estimates', 'invoices', 'calendar_tasks']
const REFERENCE_ENTITIES = ['job_statuses', 'job_categories', 'payment_types', 'sources', 'techs']

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === 'completed' ? 'bg-green-100 text-green-700' :
    status === 'running' || status === 'partial' ? 'bg-yellow-100 text-yellow-700' :
    status === 'failed' ? 'bg-red-100 text-red-700' :
    'bg-gray-100 text-gray-500'
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${classes}`}>
      {status}
    </span>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

export default function SfSyncClient({ runs, counts }: Props) {
  const router = useRouter()
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function handleSyncNow() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/admin/sf-sync/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync-now' }),
      })
      const text = await res.text()
      if (res.status === 504 || text.includes('FUNCTION_INVOCATION_TIMEOUT')) {
        setSyncResult({ ok: false, message: 'Timed out — sync may have partially completed. Refresh to check status.' })
      } else if (!res.ok) {
        setSyncResult({ ok: false, message: `Error ${res.status}: ${text.slice(0, 200)}` })
      } else {
        setSyncResult({ ok: true, message: 'Sync completed successfully.' })
        router.refresh()
      }
    } catch (err) {
      setSyncResult({ ok: false, message: err instanceof Error ? err.message : 'Request failed' })
    } finally {
      setSyncing(false)
    }
  }

  // Build lookup: entity -> run_type -> latest run
  const latestByEntityAndType: Record<string, Record<string, SyncRun>> = {}
  for (const run of runs) {
    if (!latestByEntityAndType[run.entity]) latestByEntityAndType[run.entity] = {}
    if (!latestByEntityAndType[run.entity][run.run_type]) {
      latestByEntityAndType[run.entity][run.run_type] = run
    }
  }

  // Last successful incremental run across all entities
  const lastSync = SYNC_ENTITIES
    .map(e => latestByEntityAndType[e]?.['incremental'])
    .filter(r => r?.status === 'completed')
    .sort((a, b) => new Date(b!.started_at).getTime() - new Date(a!.started_at).getTime())[0]

  return (
    <div className="space-y-8">
      {/* Header + Sync Now */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Service Fusion Sync</h1>
          {lastSync && (
            <p className="text-sm text-gray-500 mt-0.5">
              Last synced {relativeTime(lastSync.started_at)} · runs automatically every morning
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {syncResult && (
            <span className={`text-sm ${syncResult.ok ? 'text-green-700' : 'text-red-600'}`}>
              {syncResult.message}
            </span>
          )}
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-60 transition-colors"
          >
            {syncing ? <><Spinner /> Syncing…</> : 'Sync Now'}
          </button>
        </div>
      </div>

      {/* Mirror Record Counts */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Mirror Record Counts
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {Object.entries(COUNT_LABELS).map(([table, label]) => (
            <div key={table} className="bg-white border border-gray-200 rounded-lg px-4 py-3 text-center">
              <div className="text-2xl font-bold text-gray-900">
                {(counts[table] ?? 0).toLocaleString()}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Sync Status by Entity */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Sync Status by Entity
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4">
          {SYNC_ENTITIES.map(entity => {
            const run = latestByEntityAndType[entity]?.['incremental']
            return (
              <div key={entity} className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
                <span className="font-medium text-gray-800 capitalize text-sm">{entity.replace(/_/g, ' ')}</span>
                {run ? (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <StatusBadge status={run.status} />
                    <span>{relativeTime(run.started_at)}</span>
                    <span className="text-gray-400">{run.records_upserted.toLocaleString()} rows</span>
                    {(run.status === 'failed' || run.status === 'partial') && run.error_message && (
                      <span className="text-red-500 max-w-xs truncate" title={run.error_message}>
                        {run.error_message.slice(0, 60)}{run.error_message.length > 60 ? '…' : ''}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-gray-400">never synced</span>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Reference Tables */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Reference Tables
        </h2>
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {REFERENCE_ENTITIES.map(entity => {
            const run = latestByEntityAndType[entity]?.['reference']
            return (
              <div key={entity} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-medium text-gray-700 capitalize">{entity.replace(/_/g, ' ')}</span>
                {run ? (
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <StatusBadge status={run.status} />
                    <span>{relativeTime(run.started_at)}</span>
                    <span className="text-gray-400">{run.records_upserted.toLocaleString()} rows</span>
                  </div>
                ) : (
                  <span className="text-xs text-gray-400">never synced</span>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
