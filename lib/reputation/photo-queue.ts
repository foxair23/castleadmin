import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchJobPictures, storeJobPhoto } from './photos'
import { categoryAllowed, CANCELLED_STATUSES } from './post-rules'
import { loadReputationSettings } from './settings'

// Job photos through the office Chrome extension (migration 138). The app decides
// WHICH jobs need photos and records what came back; the extension only reads the
// Service Fusion job page and posts the pictures, one request per picture.
//
// Flow: the hourly enqueue pass queues finished jobs in allowed categories that
// have no stored photos yet → the extension's poll picks them up (during office
// hours, whenever the machine is on) → each picture lands in job_photos through
// storeJobPhoto → the 6am post pass scores them and drafts the post.

const MAX_ATTEMPTS = 3
const CANCELLED = CANCELLED_STATUSES

export interface PhotoQueueItem { id: string; sfJobId: string; jobNumber: string | null; known: string[]; discovered: boolean; attempts: number }

/** Queue one job. Known file names come from the API listing so the extension can match them on the page. */
export async function enqueuePhotoFetch(db: SupabaseClient, sfJobId: string, opts: { jobNumber?: string | null; knownFiles?: string[]; force?: boolean } = {}): Promise<{ ok: boolean; status?: string; error?: string }> {
  let known = opts.knownFiles
  if (!known) {
    try { known = (await fetchJobPictures(sfJobId)).pictures.map(p => p.fileLocation) } catch { known = [] }
  }
  let jobNumber = opts.jobNumber ?? null
  if (!jobNumber) {
    const { data } = await db.from('sf_jobs').select('number').eq('id', sfJobId).maybeSingle()
    jobNumber = (data as { number: string | null } | null)?.number ?? null
  }
  const { data: existing } = await db.from('sf_photo_fetch_queue').select('id, status').eq('sf_job_id', sfJobId).maybeSingle()
  if (existing && !opts.force) return { ok: true, status: existing.status as string }
  const row = { sf_job_id: sfJobId, sf_job_number: jobNumber, known_files: known, status: 'pending', attempts: 0, received: 0, error: null, finished_at: null }
  const { error } = existing
    ? await db.from('sf_photo_fetch_queue').update(row).eq('id', existing.id as string)
    : await db.from('sf_photo_fetch_queue').insert(row)
  return error ? { ok: false, error: error.message } : { ok: true, status: 'pending' }
}

/** Finished jobs from the last two days, in allowed categories, that have no stored photo and are not queued yet. */
export async function enqueueRecentJobs(db: SupabaseClient, opts: { hoursBack?: number; limit?: number } = {}): Promise<{ considered: number; queued: number }> {
  const settings = await loadReputationSettings(db)
  const since = new Date(Date.now() - (opts.hoursBack ?? 48) * 3_600_000).toISOString()
  const { data } = await db.from('sf_jobs').select('id, number, category, work_completed_at')
    .not('work_completed_at', 'is', null).gte('work_completed_at', since).gte('work_completed_at', settings.posts_since)
    .eq('is_deleted', false).not('status', 'in', `(${CANCELLED.map(s => `"${s}"`).join(',')})`)
    .order('work_completed_at', { ascending: false }).limit(opts.limit ?? 200)
  const jobs = ((data ?? []) as Array<{ id: string; number: string | null; category: string | null }>).filter(j => categoryAllowed(j.category, settings.post_allowed_categories))
  if (!jobs.length) return { considered: 0, queued: 0 }
  const ids = jobs.map(j => j.id)
  const [{ data: queued }, { data: photos }] = await Promise.all([
    db.from('sf_photo_fetch_queue').select('sf_job_id').in('sf_job_id', ids),
    db.from('job_photos').select('sf_job_id').in('sf_job_id', ids).not('storage_path', 'is', null),
  ])
  const skip = new Set([...((queued ?? []) as Array<{ sf_job_id: string }>).map(q => q.sf_job_id), ...((photos ?? []) as Array<{ sf_job_id: string }>).map(p => p.sf_job_id)])
  let n = 0
  for (const j of jobs) {
    if (skip.has(j.id)) continue
    const r = await enqueuePhotoFetch(db, j.id, { jobNumber: j.number })
    if (r.ok) n++
  }
  return { considered: jobs.length, queued: n }
}

/** What the extension should fetch next. Items already discovered but not fetched are sent again so a fix can rerun them. */
export async function getPhotoFetchQueue(db: SupabaseClient, limit = 10): Promise<{ items: PhotoQueueItem[] }> {
  const { data } = await db.from('sf_photo_fetch_queue').select('id, sf_job_id, sf_job_number, known_files, attempts, discovery')
    .eq('status', 'pending').lt('attempts', MAX_ATTEMPTS).order('created_at', { ascending: true }).limit(limit)
  const items: PhotoQueueItem[] = []
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    let jobNumber = (r.sf_job_number as string | null) ?? null
    if (!jobNumber) {
      const { data: j } = await db.from('sf_jobs').select('number').eq('id', r.sf_job_id as string).maybeSingle()
      jobNumber = (j as { number: string | null } | null)?.number ?? null
    }
    if (!jobNumber) continue // the extension finds a job through global search by number
    items.push({ id: r.id as string, sfJobId: r.sf_job_id as string, jobNumber, known: (r.known_files as string[]) ?? [], discovered: !!r.discovery, attempts: (r.attempts as number) ?? 0 })
  }
  return { items }
}

export interface PhotoCallback {
  id: string
  /** One picture: stored immediately. `name` is the file name as Service Fusion lists it when known. */
  photo?: { name: string | null; sourceRef: string; contentType: string | null; base64: string }
  /** What the extension saw on the job page. Stored on the queue row for the diagnostics. */
  discovery?: unknown
  /** End of this item: ok with a count, or a failure. */
  done?: { ok: boolean; received?: number; noPictures?: boolean; error?: string | null }
}

/** Record one callback from the extension. Several arrive per item: photos first, `done` last. */
export async function recordPhotoFetchResult(db: SupabaseClient, cb: PhotoCallback): Promise<{ ok: boolean; error?: string; photoId?: string | null }> {
  const { data: row } = await db.from('sf_photo_fetch_queue').select('id, sf_job_id, status, attempts, received').eq('id', cb.id).maybeSingle()
  if (!row) return { ok: false, error: 'queue item not found' }
  const now = new Date().toISOString()
  const sfJobId = row.sf_job_id as string
  if (cb.discovery !== undefined) await db.from('sf_photo_fetch_queue').update({ discovery: cb.discovery, discovered_at: now }).eq('id', cb.id)
  if (cb.photo) {
    const bytes = Buffer.from(cb.photo.base64, 'base64')
    if (bytes.byteLength < 2_000) return { ok: false, error: 'photo too small to be a picture' }
    const r = await storeJobPhoto(db, sfJobId, { sourceRef: cb.photo.sourceRef, name: cb.photo.name, bytes })
    if (!r.ok) return { ok: false, error: r.error }
    await db.from('sf_photo_fetch_queue').update({ received: ((row.received as number) ?? 0) + 1 }).eq('id', cb.id)
    return { ok: true, photoId: r.id }
  }
  if (cb.done) {
    const attempts = ((row.attempts as number) ?? 0) + 1
    if (cb.done.ok) {
      await db.from('sf_photo_fetch_queue').update({ status: cb.done.noPictures ? 'no_pictures' : 'done', attempts, error: null, finished_at: now }).eq('id', cb.id)
    } else {
      await db.from('sf_photo_fetch_queue').update({ status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, error: (cb.done.error ?? 'unknown error').slice(0, 500) }).eq('id', cb.id)
    }
  }
  return { ok: true }
}

/** For the Posts diagnostic: where one job stands. */
export async function photoQueueStatus(db: SupabaseClient, sfJobId: string): Promise<{ status: string; attempts: number; received: number; error: string | null; discovery: unknown; finishedAt: string | null; createdAt: string } | null> {
  const { data } = await db.from('sf_photo_fetch_queue').select('status, attempts, received, error, discovery, finished_at, created_at').eq('sf_job_id', sfJobId).maybeSingle()
  if (!data) return null
  const r = data as Record<string, unknown>
  return { status: r.status as string, attempts: (r.attempts as number) ?? 0, received: (r.received as number) ?? 0, error: (r.error as string | null) ?? null, discovery: r.discovery ?? null, finishedAt: (r.finished_at as string | null) ?? null, createdAt: r.created_at as string }
}
