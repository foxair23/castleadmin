import { SupabaseClient } from '@supabase/supabase-js'
import type { AnalyticsCrmProvider, SfRawJob, SfRawInvoice, SfRawEstimate, SfRawCustomer } from '../crm/types'
import { classifyReschedule, isPartialCompleteStatus } from './reschedule'

export interface SyncStats {
  jobsUpserted: number
  invoicesUpserted: number
  estimatesUpserted: number
  customersUpserted: number
  scheduleChanges: number
  statusChanges: number
}

// ── Ref table sync ────────────────────────────────────────────────────────

export async function syncRefTables(db: SupabaseClient, provider: AnalyticsCrmProvider): Promise<void> {
  const [statuses, categories] = await Promise.all([
    provider.listJobStatuses(),
    provider.listJobCategories(),
  ])

  if (statuses.length > 0) {
    await db.from('sf_job_statuses_ref').upsert(
      statuses.map(s => ({
        id: String(s.id),
        name: s.name,
        category: s.category ?? null,
        is_closed: (s.category ?? '').toLowerCase().includes('closed'),
        synced_at: new Date().toISOString(),
      })),
      { onConflict: 'id' }
    )
  }

  if (categories.length > 0) {
    await db.from('sf_job_categories_ref').upsert(
      categories.map(c => ({
        id: String(c.id),
        name: c.name,
        synced_at: new Date().toISOString(),
      })),
      { onConflict: 'id' }
    )
  }
}

// ── Job processing ────────────────────────────────────────────────────────

export async function processJob(
  db: SupabaseClient,
  raw: SfRawJob,
  opts: { isBackfill: boolean }
): Promise<{ scheduleChanged: boolean; statusChanged: boolean }> {
  const now = new Date().toISOString()
  const jobId = String(raw.id)

  const scheduledAt = raw.start_date ? new Date(raw.start_date).toISOString() : null
  const completedAt = raw.closed_at ? new Date(raw.closed_at).toISOString() : null
  const createdAtSf = raw.created_at ? new Date(raw.created_at).toISOString() : null
  const statusName = raw.status ?? ''
  const isClosed = statusName.toLowerCase().includes('closed') ||
    statusName.toLowerCase().includes('completed') ||
    statusName.toLowerCase().includes('invoiced') ||
    statusName.toLowerCase().includes('paid')

  // ── Fetch existing cached record ──────────────────────────────────────
  const { data: existing } = await db
    .from('sf_jobs_cache')
    .select('status_name, scheduled_at, original_scheduled_at, reschedule_count, parts_reschedule_count, multi_visit, visit_count, schedule_history_truncated')
    .eq('id', jobId)
    .maybeSingle()

  // ── Status history ────────────────────────────────────────────────────
  let statusChanged = false
  const prevStatus = existing?.status_name ?? null

  if (prevStatus !== statusName && statusName) {
    statusChanged = true
    await db.from('sf_job_status_history').insert({
      sf_job_id: jobId,
      status: statusName,
      status_category: isClosed ? 'Closed Jobs' : 'Open Jobs',
      previous_status: prevStatus,
      observed_at: now,
    })

    // Track multi-visit: if job enters a partial-complete state
    if (isPartialCompleteStatus(statusName) && existing && !existing.multi_visit) {
      await db.from('sf_jobs_cache').update({ multi_visit: true }).eq('id', jobId)
    }
  }

  // ── Schedule history ──────────────────────────────────────────────────
  let scheduleChanged = false
  let originalScheduledAt = existing?.original_scheduled_at ?? null
  let rescheduleCount = existing?.reschedule_count ?? 0
  let partsRescheduleCount = existing?.parts_reschedule_count ?? 0
  let scheduleHistoryTruncated = existing?.schedule_history_truncated ?? false

  if (!existing) {
    // First time seeing this job
    originalScheduledAt = scheduledAt
    scheduleHistoryTruncated = opts.isBackfill
    if (scheduledAt) {
      await db.from('sf_job_schedule_history').insert({
        sf_job_id: jobId,
        scheduled_at: scheduledAt,
        previous_scheduled_at: null,
        observed_at: now,
        change_type: 'initial',
        reschedule_reason: null,
        reschedule_reason_source: null,
        job_status_at_change: statusName,
      })
    }
  } else if (scheduledAt && existing.scheduled_at !== scheduledAt) {
    // Schedule changed
    scheduleChanged = true

    const classification = classifyReschedule({
      previousScheduledAt: new Date(existing.scheduled_at ?? scheduledAt),
      newScheduledAt: new Date(scheduledAt),
      observedAt: new Date(),
      jobStatusAtChange: statusName,
    })

    const changeType = isClosed ? 'cancelled' : 'rescheduled'

    await db.from('sf_job_schedule_history').insert({
      sf_job_id: jobId,
      scheduled_at: scheduledAt,
      previous_scheduled_at: existing.scheduled_at,
      observed_at: now,
      change_type: changeType,
      reschedule_reason: changeType === 'rescheduled' ? classification.reason : null,
      reschedule_reason_source: changeType === 'rescheduled' ? classification.source : null,
      job_status_at_change: statusName,
    })

    if (changeType === 'rescheduled') {
      rescheduleCount++
      if (classification.reason === 'parts_or_incomplete') partsRescheduleCount++
    }
  }

  // ── Upsert sf_jobs_cache ──────────────────────────────────────────────
  await db.from('sf_jobs_cache').upsert({
    id: jobId,
    customer_id: raw.customer_id ? String(raw.customer_id) : null,
    category_name: raw.category ?? null,
    status_name: statusName,
    status_category: isClosed ? 'Closed Jobs' : 'Open Jobs',
    is_closed: isClosed,
    created_at_sf: createdAtSf,
    scheduled_at: scheduledAt,
    original_scheduled_at: originalScheduledAt,
    completed_at: completedAt,
    total_amount: raw.total != null ? parseFloat(String(raw.total)) : null,
    lead_source: raw.source ?? null,
    zip: raw.postal_code ?? null,
    reschedule_count: rescheduleCount,
    parts_reschedule_count: partsRescheduleCount,
    schedule_history_truncated: scheduleHistoryTruncated,
    synced_at: now,
  }, { onConflict: 'id' })

  // ── Tech assignments ──────────────────────────────────────────────────
  const techs = raw.techs_assigned ?? []
  if (techs.length > 0) {
    await db.from('sf_job_techs_cache').upsert(
      techs.map(t => ({
        sf_job_id: jobId,
        sf_tech_id: String(t.id),
        synced_at: now,
      })),
      { onConflict: 'sf_job_id,sf_tech_id' }
    )
  }

  return { scheduleChanged, statusChanged }
}

// ── Batch job processing (backfill) ───────────────────────────────────────
// Processes an array of raw jobs in 5 DB round-trips total instead of ~5×N.
// Returns count of records upserted.

export async function processJobsBatch(
  db: SupabaseClient,
  raws: SfRawJob[],
  opts: { isBackfill: boolean }
): Promise<number> {
  if (raws.length === 0) return 0
  const now = new Date().toISOString()

  const jobIds = raws.map(r => String(r.id))

  // 1. Bulk-fetch existing cache rows
  const { data: existingRows } = await db
    .from('sf_jobs_cache')
    .select('id, status_name, scheduled_at, original_scheduled_at, reschedule_count, parts_reschedule_count, multi_visit, schedule_history_truncated')
    .in('id', jobIds)

  const existingMap = new Map<string, typeof existingRows extends (infer T)[] | null ? T : never>()
  for (const row of existingRows ?? []) existingMap.set(row.id, row)

  // 2. Compute all changes in memory
  const jobRows: Record<string, unknown>[] = []
  const statusHistoryRows: Record<string, unknown>[] = []
  const schedHistoryRows: Record<string, unknown>[] = []
  const techRows: Record<string, unknown>[] = []

  for (const raw of raws) {
    const jobId = String(raw.id)
    const scheduledAt = raw.start_date ? new Date(raw.start_date).toISOString() : null
    const completedAt = raw.closed_at ? new Date(raw.closed_at).toISOString() : null
    const createdAtSf = raw.created_at ? new Date(raw.created_at).toISOString() : null
    const statusName = raw.status ?? ''
    const isClosed = statusName.toLowerCase().includes('closed') ||
      statusName.toLowerCase().includes('completed') ||
      statusName.toLowerCase().includes('invoiced') ||
      statusName.toLowerCase().includes('paid')

    const existing = existingMap.get(jobId) ?? null
    const prevStatus = existing?.status_name ?? null

    // Status history
    if (prevStatus !== statusName && statusName) {
      statusHistoryRows.push({
        sf_job_id: jobId,
        status: statusName,
        status_category: isClosed ? 'Closed Jobs' : 'Open Jobs',
        previous_status: prevStatus,
        observed_at: now,
      })
    }

    // Schedule history
    let originalScheduledAt = existing?.original_scheduled_at ?? null
    let rescheduleCount = existing?.reschedule_count ?? 0
    let partsRescheduleCount = existing?.parts_reschedule_count ?? 0
    const scheduleHistoryTruncated = existing ? (existing.schedule_history_truncated ?? false) : opts.isBackfill

    if (!existing) {
      originalScheduledAt = scheduledAt
      if (scheduledAt) {
        schedHistoryRows.push({
          sf_job_id: jobId,
          scheduled_at: scheduledAt,
          previous_scheduled_at: null,
          observed_at: now,
          change_type: 'initial',
          reschedule_reason: null,
          reschedule_reason_source: null,
          job_status_at_change: statusName,
        })
      }
    } else if (scheduledAt && existing.scheduled_at !== scheduledAt) {
      const classification = classifyReschedule({
        previousScheduledAt: new Date(existing.scheduled_at ?? scheduledAt),
        newScheduledAt: new Date(scheduledAt),
        observedAt: new Date(),
        jobStatusAtChange: statusName,
      })
      const changeType = isClosed ? 'cancelled' : 'rescheduled'
      schedHistoryRows.push({
        sf_job_id: jobId,
        scheduled_at: scheduledAt,
        previous_scheduled_at: existing.scheduled_at,
        observed_at: now,
        change_type: changeType,
        reschedule_reason: changeType === 'rescheduled' ? classification.reason : null,
        reschedule_reason_source: changeType === 'rescheduled' ? classification.source : null,
        job_status_at_change: statusName,
      })
      if (changeType === 'rescheduled') {
        rescheduleCount++
        if (classification.reason === 'parts_or_incomplete') partsRescheduleCount++
      }
    }

    // Main cache row
    jobRows.push({
      id: jobId,
      customer_id: raw.customer_id ? String(raw.customer_id) : null,
      category_name: raw.category ?? null,
      status_name: statusName,
      status_category: isClosed ? 'Closed Jobs' : 'Open Jobs',
      is_closed: isClosed,
      created_at_sf: createdAtSf,
      scheduled_at: scheduledAt,
      original_scheduled_at: originalScheduledAt,
      completed_at: completedAt,
      total_amount: raw.total != null ? parseFloat(String(raw.total)) : null,
      lead_source: raw.source ?? null,
      zip: raw.postal_code ?? null,
      reschedule_count: rescheduleCount,
      parts_reschedule_count: partsRescheduleCount,
      schedule_history_truncated: scheduleHistoryTruncated,
      synced_at: now,
    })

    // Tech assignments
    for (const t of raw.techs_assigned ?? []) {
      techRows.push({ sf_job_id: jobId, sf_tech_id: String(t.id), synced_at: now })
    }
  }

  // 3. Batch writes (5 round-trips total regardless of page size)
  await db.from('sf_jobs_cache').upsert(jobRows as Parameters<ReturnType<typeof db.from>['upsert']>[0], { onConflict: 'id' })
  if (statusHistoryRows.length > 0) {
    await db.from('sf_job_status_history').insert(statusHistoryRows as Parameters<ReturnType<typeof db.from>['insert']>[0])
  }
  if (schedHistoryRows.length > 0) {
    await db.from('sf_job_schedule_history').insert(schedHistoryRows as Parameters<ReturnType<typeof db.from>['insert']>[0])
  }
  if (techRows.length > 0) {
    await db.from('sf_job_techs_cache').upsert(techRows as Parameters<ReturnType<typeof db.from>['upsert']>[0], { onConflict: 'sf_job_id,sf_tech_id' })
  }

  return raws.length
}


// Batched callback detection — 3 DB round-trips regardless of batch size.
// Heuristic: a job is a callback if another closed job at the same zip
// completed within the 30 days before it.
export async function detectCallbacks(db: SupabaseClient, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return

  // 1. Fetch the batch jobs that are closed and have a zip + completed_at
  const { data: jobs } = await db
    .from('sf_jobs_cache')
    .select('id, zip, completed_at')
    .in('id', jobIds)
    .eq('is_closed', true)
    .not('zip', 'is', null)
    .not('completed_at', 'is', null)

  if (!jobs || jobs.length === 0) return

  // 2. Fetch all closed jobs at the relevant zips within a 30-day lookback window
  const zips = [...new Set(jobs.map(j => j.zip as string))]
  const times = jobs.map(j => new Date(j.completed_at as string).getTime())
  const windowStart = new Date(Math.min(...times) - 30 * 86_400_000).toISOString()
  const windowEnd = new Date(Math.max(...times)).toISOString()
  const batchIdSet = new Set(jobIds)

  const { data: context } = await db
    .from('sf_jobs_cache')
    .select('id, zip, completed_at')
    .in('zip', zips)
    .eq('is_closed', true)
    .gte('completed_at', windowStart)
    .lte('completed_at', windowEnd)

  if (!context) return

  // Build a map of zip → sorted completed dates for non-batch jobs
  const priorByZip = new Map<string, number[]>()
  for (const row of context) {
    if (batchIdSet.has(row.id as string)) continue
    const z = row.zip as string
    if (!priorByZip.has(z)) priorByZip.set(z, [])
    priorByZip.get(z)!.push(new Date(row.completed_at as string).getTime())
  }

  // Determine which batch jobs are callbacks
  const callbackIds: string[] = []
  for (const job of jobs) {
    const z = job.zip as string
    const completedTime = new Date(job.completed_at as string).getTime()
    const thirtyBefore = completedTime - 30 * 86_400_000
    const priors = priorByZip.get(z) ?? []
    if (priors.some(t => t < completedTime && t >= thirtyBefore)) {
      callbackIds.push(job.id as string)
    }
  }

  // 3. Batch-update the callbacks
  if (callbackIds.length > 0) {
    await db.from('sf_jobs_cache')
      .update({ is_callback: true, callback_source: 'heuristic' })
      .in('id', callbackIds)
  }
}

// ── Invoice processing ────────────────────────────────────────────────────

export async function processInvoices(db: SupabaseClient, items: SfRawInvoice[]): Promise<number> {
  if (items.length === 0) return 0
  const now = new Date().toISOString()

  const rows = items.map(inv => ({
    id: String(inv.id),
    job_id: inv.job_id ? String(inv.job_id) : null,
    customer_id: inv.customer_id ? String(inv.customer_id) : null,
    issued_at: inv.created ? new Date(inv.created).toISOString() : null,
    due_at: inv.due_date ? new Date(inv.due_date).toISOString() : null,
    total: inv.total != null ? parseFloat(String(inv.total)) : null,
    balance_due: inv.balance != null ? parseFloat(String(inv.balance)) : null,
    paid_at: inv.paid_date ? new Date(inv.paid_date).toISOString() : null,
    synced_at: now,
  }))

  await db.from('sf_invoices_cache').upsert(rows, { onConflict: 'id' })
  return rows.length
}

// ── Estimate processing ───────────────────────────────────────────────────

export async function processEstimates(db: SupabaseClient, items: SfRawEstimate[]): Promise<number> {
  if (items.length === 0) return 0
  const now = new Date().toISOString()

  const rows = items.map(est => ({
    id: String(est.id),
    customer_id: est.customer_id ? String(est.customer_id) : null,
    assigned_tech_id: est.tech_id ? String(est.tech_id) : null,
    status: est.status ?? null,
    created_at_sf: est.created ? new Date(est.created).toISOString() : null,
    accepted_at: est.accepted_date ? new Date(est.accepted_date).toISOString() : null,
    declined_at: est.declined_date ? new Date(est.declined_date).toISOString() : null,
    total: est.total != null ? parseFloat(String(est.total)) : null,
    synced_at: now,
  }))

  await db.from('sf_estimates_cache').upsert(rows, { onConflict: 'id' })
  return rows.length
}

// ── Customer processing ───────────────────────────────────────────────────

export async function processCustomers(db: SupabaseClient, items: SfRawCustomer[]): Promise<number> {
  if (items.length === 0) return 0
  const now = new Date().toISOString()

  const rows = items.map(c => ({
    id: String(c.id),
    created_at_sf: c.created ? new Date(c.created).toISOString() : null,
    lead_source: c.lead_source ?? null,
    zip: c.zip ?? null,
    synced_at: now,
  }))

  await db.from('sf_customers_cache').upsert(rows, { onConflict: 'id' })
  return rows.length
}

// ── Incremental sync (nightly / manual refresh) ───────────────────────────
// Pulls a date window of jobs + invoices + estimates.
// dateFrom / dateTo are YYYY-MM-DD strings.

export async function runIncrementalSync(
  db: SupabaseClient,
  provider: AnalyticsCrmProvider,
  dateFrom: string,
  dateTo: string,
  logId: string
): Promise<SyncStats> {
  const stats: SyncStats = {
    jobsUpserted: 0, invoicesUpserted: 0, estimatesUpserted: 0,
    customersUpserted: 0, scheduleChanges: 0, statusChanges: 0,
  }

  // Sync ref tables first
  await syncRefTables(db, provider)

  // ── Jobs ──────────────────────────────────────────────────────────────
  const jobIds: string[] = []
  let page = 1
  while (true) {
    const resp = await provider.listJobsPaged(page, 50, {
      'filters[start_date][gte]': dateFrom,
      'filters[start_date][lte]': dateTo,
    })
    for (const raw of resp.items) {
      const { scheduleChanged, statusChanged } = await processJob(db, raw, { isBackfill: false })
      jobIds.push(String(raw.id))
      stats.jobsUpserted++
      if (scheduleChanged) stats.scheduleChanges++
      if (statusChanged) stats.statusChanges++
    }
    if (page >= resp._meta.pageCount) break
    page++
  }

  await detectCallbacks(db, jobIds)

  // ── Invoices ──────────────────────────────────────────────────────────
  page = 1
  while (true) {
    const resp = await provider.listInvoicesPaged(page, 100, {
      'filters[created][gte]': dateFrom,
      'filters[created][lte]': dateTo,
    })
    stats.invoicesUpserted += await processInvoices(db, resp.items)
    if (page >= resp._meta.pageCount) break
    page++
  }

  // ── Estimates ─────────────────────────────────────────────────────────
  page = 1
  while (true) {
    const resp = await provider.listEstimatesPaged(page, 100, {
      'filters[created][gte]': dateFrom,
      'filters[created][lte]': dateTo,
    })
    stats.estimatesUpserted += await processEstimates(db, resp.items)
    if (page >= resp._meta.pageCount) break
    page++
  }

  // Update log
  await db.from('analytics_sync_log').update({
    status: 'complete',
    completed_at: new Date().toISOString(),
    records_synced: stats.jobsUpserted + stats.invoicesUpserted + stats.estimatesUpserted,
  }).eq('id', logId)

  return stats
}
