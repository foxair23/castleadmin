import type { SupabaseClient } from '@supabase/supabase-js'
import { createLocalPost } from '@/lib/google-reviews/gbp-client'
import type { HandlerResult, QueueRowLike } from './dispatcher'
import type { ReputationSettings } from './settings'
import { PHOTO_SELECT, type JobPhotoRow } from './photos'

// Publishes one approved profile post when its queue row comes due. Re-checks
// the posts autopilot switch for autopilot approvals, and refuses to publish
// without at least one photo that still has a public URL.

export async function sendGbpPost(db: SupabaseClient, row: QueueRowLike, settings: ReputationSettings): Promise<HandlerResult> {
  const { data } = await db.from('gbp_posts').select('id, status, final_text, photo_ids, cta_type, cta_url, approved_by').eq('id', row.ref_id).maybeSingle()
  const p = data as { id: string; status: string; final_text: string | null; photo_ids: string[]; cta_type: 'LEARN_MORE' | 'CALL'; cta_url: string | null; approved_by: string | null } | null
  if (!p) return { ok: false, error: 'post row missing', retry: false, cancel: true }
  if (p.status !== 'scheduled') return { ok: false, error: `post is ${p.status}`, retry: false, cancel: true }
  if (!p.final_text?.trim()) return { ok: false, error: 'post has no text', retry: false, cancel: true }
  const now = new Date().toISOString()
  if (p.approved_by === null && !settings.autopilot_posts) {
    await db.from('gbp_posts').update({ status: 'draft', approved_at: null, scheduled_for: null, push_reasons: [], updated_at: now }).eq('id', p.id)
    return { ok: false, error: 'posts autopilot switched off before publish', retry: false, cancel: true }
  }
  const { data: photos } = await db.from('job_photos').select(PHOTO_SELECT).in('id', p.photo_ids.length ? p.photo_ids : ['00000000-0000-0000-0000-000000000000'])
  const ordered = p.photo_ids.map(id => ((photos ?? []) as JobPhotoRow[]).find(ph => ph.id === id)).filter((ph): ph is JobPhotoRow => !!ph && !!ph.public_url)
  if (!ordered.length) {
    await db.from('gbp_posts').update({ status: 'failed', error: 'no photo with a public URL', updated_at: now }).eq('id', p.id)
    return { ok: false, error: 'no photo with a public URL', retry: false, cancel: true }
  }
  const res = await createLocalPost({
    summary: p.final_text,
    mediaUrls: ordered.map(ph => ph.public_url!),
    callToAction: p.cta_type === 'CALL' ? { actionType: 'CALL' } : { actionType: 'LEARN_MORE', url: p.cta_url ?? undefined },
  })
  if (!res.ok) return { ok: false, error: res.error, retry: res.status === 0 || res.status === 429 || res.status >= 500 }
  await db.from('gbp_posts').update({ status: 'published', published_at: now, google_post_name: res.name, google_state: res.state, error: null, updated_at: now }).eq('id', p.id)
  return { ok: true }
}

export async function failGbpPost(db: SupabaseClient, postId: string, error: string): Promise<void> {
  await db.from('gbp_posts').update({ status: 'failed', error: error.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', postId)
}
