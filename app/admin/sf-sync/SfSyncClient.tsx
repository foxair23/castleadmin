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

const INCREMENTAL_ENTITIES = ['customers', 'jobs', 'estimates', 'invoices', 'calendar_tasks']
const REFERENCE_ENTITIES = ['job_statuses', 'job_categories', 'payment_types', 'sources', 'techs']

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === 'completed'
      ? 'bg-green-100 text-green-700'
      : status === 'running' || status === 'partial'
      ? 'bg-yellow-100 text-yellow-700'
      : status === 'failed'
      ? 'bg-red-100 text-red-700'
      : 'bg-gray-100 text-gray-500'

  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${classes}`}>
      {status}
    </span>
  )
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 inline-block"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  )
}

export default function SfSyncClient({ runs, counts }: Props) {
  const router = useRouter()
  const [inflight, setInflight] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  async function trigger(action: string, entity?: string) {
    if (inflight) return
    if (action === 'backfill') {
      const msg = entity
        ? `This will page through all SF data for "${entity}". Continue?`
        : 'This will page through all SF data. Continue?'
      if (!confirm(msg)) return
    }

    setInflight(true)
    setActionError(null)

    try {
      const res = await fetch('/api/admin/sf-sync/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, entity }),
      })

      if (!res.ok) {
        const text = await res.text()
        if (res.status === 504 || text.toLowerCase().includes('timed out') || text.includes('FUNCTION_INVOCATION_TIMEOUT')) {
          setActionError('Timed out (300s Vercel limit). Progress was saved — click the same button again to resume from where it left off.')
        } else {
          setActionError(`Server error ${res.status}: ${text.slice(0, 300)}`)
        }
        router.refresh()
        return
      }

      const json = await res.json()
      if (!json.ok) {
        setActionError(json.error ?? 'Unknown error')
      } else {
        router.refresh()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setInflight(false)
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

  return (
    <div className="space-y-8">
      {/* Header + actions */}
      <div className="space-y-3">
        <h1 className="text-xl font-bold text-gray-900">Service Fusion Sync</h1>

        <div className="flex flex-wrap gap-2">
          <ActionButton label="Run Reference Sync" loading={inflight} onClick={() => trigger('reference')} />
          <ActionButton label="Run Incremental Sync" loading={inflight} onClick={() => trigger('incremental')} />
          <ActionButton label="Run Weekly Reconcile" loading={inflight} onClick={() => trigger('reconcile')} />
          <ActionButton
            label="Run Full Backfill"
            loading={inflight}
            onClick={() => trigger('backfill')}
            variant="danger"
          />
          <ActionButton
            label="Re-sync Customer Contacts"
            loading={inflight}
            onClick={() => trigger('reprocess-children')}
          />
        </div>

        {actionError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {actionError}
          </p>
        )}
      </div>

      {/* Section 1: Mirror Record Counts */}
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

      {/* Section 2: Sync Status by Entity */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
          Sync Status by Entity
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {INCREMENTAL_ENTITIES.map(entity => {
            const byType = latestByEntityAndType[entity] ?? {}
            return (
              <div key={entity} className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-800 capitalize">
                    {entity.replace(/_/g, ' ')}
                  </h3>
                  <ActionButton
                    label="Backfill"
                    size="sm"
                    loading={inflight}
                    onClick={() => trigger('backfill', entity)}
                    variant="danger"
                  />
                </div>

                {(['incremental', 'backfill', 'reconcile'] as const).map(type => {
                  const run = byType[type]
                  if (!run) {
                    return (
                      <RunRow key={type} type={type} empty />
                    )
                  }
                  return (
                    <RunRow key={type} type={type} run={run} />
                  )
                })}
              </div>
            )
          })}
        </div>
      </section>

      {/* Section 3: Reference Tables */}
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

function RunRow({
  type,
  run,
  empty,
}: {
  type: string
  run?: SyncRun
  empty?: boolean
}) {
  return (
    <div className="text-xs space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="text-gray-400 w-20 capitalize">{type}</span>
        {empty || !run ? (
          <span className="text-gray-300">—</span>
        ) : (
          <>
            <StatusBadge status={run.status} />
            <span className="text-gray-500">{relativeTime(run.started_at)}</span>
          </>
        )}
      </div>
      {run && (
        <div className="pl-22 space-y-0.5" style={{ paddingLeft: '5.5rem' }}>
          <div className="text-gray-500">
            {run.records_upserted.toLocaleString()} upserted
            {type === 'backfill' && run.pages_fetched > 0 && (
              <span className="ml-1">
                · {run.pages_fetched} pages
                {run.last_page != null ? ` (last: ${run.last_page})` : ''}
              </span>
            )}
          </div>
          {(run.status === 'failed' || run.status === 'partial') && run.error_message && (
            <div className="text-red-500 break-all max-w-xs" title={run.error_message}>
              {run.error_message.slice(0, 300)}{run.error_message.length > 300 ? '…' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ActionButton({
  label,
  loading,
  onClick,
  variant = 'default',
  size = 'md',
}: {
  label: string
  loading: boolean
  onClick: () => void
  variant?: 'default' | 'danger'
  size?: 'md' | 'sm'
}) {
  const base =
    size === 'sm'
      ? 'text-xs px-2 py-1 rounded font-medium transition-colors disabled:opacity-50 flex items-center gap-1'
      : 'text-sm px-3 py-1.5 rounded-md font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5'

  const color =
    variant === 'danger'
      ? 'bg-red-600 hover:bg-red-700 text-white'
      : 'bg-gray-800 hover:bg-gray-900 text-white'

  return (
    <button disabled={loading} onClick={onClick} className={`${base} ${color}`}>
      {loading && <Spinner />}
      {label}
    </button>
  )
}
