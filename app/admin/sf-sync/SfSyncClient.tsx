'use client'

import { useState, useEffect } from 'react'
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

const SYNC_ENTITIES = ['jobs', 'estimates', 'invoices', 'calendar_tasks'] as const
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

// Steps: reference tables, then one per incremental entity
const SYNC_STEPS: { label: string; action: string; entity?: string }[] = [
  { label: 'reference tables', action: 'reference' },
  ...SYNC_ENTITIES.map(e => ({ label: e.replace(/_/g, ' '), action: 'sync-entity', entity: e })),
]

export default function SfSyncClient({ runs, counts }: Props) {
  const router = useRouter()
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [health, setHealth] = useState<{ stale: boolean; staleEntities: string[]; errors: string[] } | null>(null)
  const [rebuildingLinks, setRebuildingLinks] = useState(false)
  const [rebuildResult, setRebuildResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Re-pull the last 12 months of jobs WITH their invoices so every invoice's
  // job link is restored (the /invoices endpoint carries no job reference —
  // links only come from the jobs expand). Slow: up to ~10 minutes.
  async function handleRebuildLinks() {
    if (!confirm('Rebuild invoice links for the last 12 months of jobs? This re-pulls each job with its invoices from Service Fusion and can take up to ~10 minutes.')) return
    setRebuildingLinks(true)
    setRebuildResult(null)
    try {
      const res = await fetch('/api/admin/sf-sync/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reconcile-scoped', days: 365, entities: ['jobs'] }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Rebuild failed')
      setRebuildResult({ ok: true, message: `Done — re-pulled ${data.counts?.jobs ?? '?'} jobs with their invoices.` })
      router.refresh()
    } catch (e) {
      setRebuildResult({ ok: false, message: e instanceof Error ? e.message : 'Rebuild failed' })
    }
    setRebuildingLinks(false)
  }

  useEffect(() => {
    fetch('/api/admin/sf-sync/health')
      .then(r => r.json())
      .then(setHealth)
      .catch(() => {})
  }, [runs])

  async function handleSyncNow() {
    setSyncing(true)
    setSyncResult(null)
    setProgress(null)

    for (let i = 0; i < SYNC_STEPS.length; i++) {
      const step = SYNC_STEPS[i]
      const MAX_RETRIES = 5
      let attempt = 0
      let succeeded = false

      while (!succeeded) {
        if (attempt > 0) {
          setProgress(`Retrying ${step.label} (attempt ${attempt + 1})…`)
        } else {
          setProgress(`Syncing ${step.label} (${i + 1}/${SYNC_STEPS.length})…`)
        }

        if (attempt >= MAX_RETRIES) {
          setSyncResult({ ok: false, message: `${step.label} failed after ${MAX_RETRIES} attempts. Check sync status for details.` })
          setSyncing(false)
          setProgress(null)
          router.refresh()
          return
        }

        try {
          const res = await fetch('/api/admin/sf-sync/trigger', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: step.action, entity: step.entity }),
          })
          const text = await res.text()

          if (res.status === 504 || text.includes('FUNCTION_INVOCATION_TIMEOUT')) {
            // Timed out — retry this step automatically
            attempt++
            continue
          }
          if (!res.ok) {
            setSyncResult({ ok: false, message: `Error on ${step.label}: ${text.slice(0, 150)}` })
            setSyncing(false)
            setProgress(null)
            router.refresh()
            return
          }
          succeeded = true
        } catch (err) {
          // Network error — retry
          attempt++
        }
      }
    }

    setSyncResult({ ok: true, message: 'All done.' })
    setSyncing(false)
    setProgress(null)
    router.refresh()
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
          {progress && (
            <span className="text-sm text-gray-500">{progress}</span>
          )}
          {!syncing && syncResult && (
            <span className={`text-sm ${syncResult.ok ? 'text-green-700' : 'text-red-600'}`}>
              {syncResult.message}
            </span>
          )}
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-60 transition-colors"
          >
            {!syncing && health?.stale && (
              <span className="h-2 w-2 rounded-full bg-yellow-400" />
            )}
            {syncing ? <><Spinner /> Syncing…</> : 'Sync Now'}
          </button>
        </div>
      </div>

      {health?.stale && !syncing && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 flex gap-3">
          <span className="text-yellow-500 mt-0.5 shrink-0">⚠</span>
          <div className="text-sm text-yellow-800 space-y-1">
            <p className="font-medium">Sync overdue — {health.staleEntities.join(', ')} {health.staleEntities.length === 1 ? 'has' : 'have'} not synced in over 30 hours.</p>
            {health.errors.map((e, i) => (
              <p key={i} className="text-yellow-700 font-mono text-xs break-all">{e}</p>
            ))}
          </div>
        </div>
      )}

      {/* Maintenance — invoice link rebuild */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 mb-1">Rebuild Invoice Links</h2>
          <p className="text-xs text-gray-500">
            Re-pulls the last 12 months of jobs with their invoices so every invoice is linked to its job
            (used by Action Items → Completed but Never Invoiced). Run this if invoiced jobs are being
            flagged as never invoiced. Takes up to ~10 minutes.
          </p>
        </div>
        {rebuildResult && (
          <div className={`text-sm px-3 py-2 rounded border ${
            rebuildResult.ok
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}>
            {rebuildResult.message}
          </div>
        )}
        <button
          onClick={handleRebuildLinks}
          disabled={rebuildingLinks || syncing}
          className="bg-gray-800 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-gray-900 disabled:opacity-60"
        >
          {rebuildingLinks ? 'Rebuilding… (up to ~10 minutes, keep this tab open)' : 'Rebuild Invoice Links (12 months)'}
        </button>
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
                  <div className="text-right">
                    <div className="flex items-center justify-end gap-2 text-xs text-gray-500">
                      <StatusBadge status={run.status} />
                      <span>{relativeTime(run.started_at)}</span>
                      <span className="text-gray-400">{run.records_upserted.toLocaleString()} rows</span>
                    </div>
                    {(run.status === 'failed' || run.status === 'partial') && run.error_message && (
                      <p className="text-xs text-red-500 mt-1 break-all text-left">{run.error_message}</p>
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
