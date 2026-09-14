import type { SupabaseClient } from '@supabase/supabase-js'
import { importJobPhotos } from './photos'
import { categoryAllowed, CANCELLED_STATUSES } from './post-rules'
import { loadReputationSettings } from './settings'

// Job photos, pulled ahead of the 6am post pass. Service Fusion's API lists a job's
// pictures by file name; the files sit in SF's public picture bucket
// (photos.ts resolvePictureUrl), so an hourly pass downloads them for finished jobs in
// allowed categories. The post pass then finds them stored and scored.

const CANCELLED = CANCELLED_STATUSES

export interface PhotoSyncReport { considered: number; downloaded: number; jobsWithPhotos: number; noPictures: number; failed: number; errors: string[] }

/** Finished jobs from the last two days, in allowed categories, that have no stored photo yet: download their pictures. */
export async function syncRecentJobPhotos(db: SupabaseClient, opts: { hoursBack?: number; limit?: number; deadline?: number } = {}): Promise<PhotoSyncReport> {
  const settings = await loadReputationSettings(db)
  const since = new Date(Date.now() - (opts.hoursBack ?? 48) * 3_600_000).toISOString()
  const report: PhotoSyncReport = { considered: 0, downloaded: 0, jobsWithPhotos: 0, noPictures: 0, failed: 0, errors: [] }
  const { data } = await db.from('sf_jobs').select('id, number, category, work_completed_at')
    .not('work_completed_at', 'is', null).gte('work_completed_at', since).gte('work_completed_at', settings.posts_since)
    .eq('is_deleted', false).not('status', 'in', `(${CANCELLED.map(s => `"${s}"`).join(',')})`)
    .order('work_completed_at', { ascending: false }).limit(200)
  const jobs = ((data ?? []) as Array<{ id: string; number: string | null; category: string | null }>).filter(j => categoryAllowed(j.category, settings.post_allowed_categories))
  if (!jobs.length) return report
  const ids = jobs.map(j => j.id)
  const { data: photos } = await db.from('job_photos').select('sf_job_id').in('sf_job_id', ids).not('storage_path', 'is', null)
  const skip = new Set(((photos ?? []) as Array<{ sf_job_id: string }>).map(p => p.sf_job_id))
  const todo = jobs.filter(j => !skip.has(j.id)).slice(0, opts.limit ?? 10)
  for (const j of todo) {
    if (opts.deadline && Date.now() > opts.deadline) break
    report.considered++
    try {
      const imp = await importJobPhotos(db, j.id)
      if (imp.imported > 0) { report.downloaded += imp.imported; report.jobsWithPhotos++; continue }
      if (imp.found === 0) { report.noPictures++; continue }
      report.failed++
      if (imp.errors.length) report.errors.push(`${j.number ?? j.id}: ${imp.errors[0]}`)
    } catch (e) {
      report.errors.push(`${j.number ?? j.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return report
}

