import type { SupabaseClient } from '@supabase/supabase-js'
import { cancelOutbound, enqueueOutbound } from './queue'
import { capturePostStyleExample } from './knowledge'
import { loadReputationSettings, type ReputationSettings } from './settings'

// What a person (or autopilot) does with a post draft: approve / edit-and-approve
// → scheduled through the queue; skip; redraft in place; swap the photos.

interface PostRow { id: string; sf_job_id: string; status: string; draft_text: string; final_text: string | null; approved_by: string | null; photo_ids: string[] }

async function getPost(db: SupabaseClient, id: string): Promise<PostRow> {
  const { data, error } = await db.from('gbp_posts').select('id, sf_job_id, status, draft_text, final_text, approved_by, photo_ids').eq('id', id).single()
  if (error || !data) throw new Error('Post not found')
  return data as PostRow
}

export type ApprovePostResult = { ok: true; scheduledFor: string; pushReasons: string[]; edited: boolean } | { ok: false; error: string }

export async function approveAndSchedulePost(db: SupabaseClient, postId: string, input: { text: string; userId: string | null; photoIds?: string[]; earliestAt?: Date }, settings?: ReputationSettings): Promise<ApprovePostResult> {
  const p = await getPost(db, postId)
  if (!['draft', 'approved', 'failed'].includes(p.status)) return { ok: false, error: `This post is already ${p.status}.` }
  const finalText = input.text.trim()
  if (!finalText) return { ok: false, error: 'The post text is empty.' }
  const photoIds = input.photoIds?.length ? input.photoIds.slice(0, 2) : p.photo_ids
  if (!photoIds.length) return { ok: false, error: 'Pick at least one photo.' }
  const edited = finalText !== p.draft_text.trim()
  const now = new Date()
  const nowIso = now.toISOString()
  const { error } = await db.from('gbp_posts').update({ status: 'approved', final_text: finalText, photo_ids: photoIds, approved_by: input.userId, approved_at: nowIso, error: null, updated_at: nowIso }).eq('id', postId)
  if (error) return { ok: false, error: error.message }
  if (input.userId) {
    const { data: job } = await db.from('sf_jobs').select('category').eq('id', p.sf_job_id).maybeSingle()
    await capturePostStyleExample(db, { jobId: p.sf_job_id, category: (job as { category: string | null } | null)?.category ?? null, draftText: p.draft_text, finalText, edited, userId: input.userId }).catch(() => {})
  }
  const s = settings ?? await loadReputationSettings(db)
  const q = await enqueueOutbound(db, s, { kind: 'gbp_post', refId: postId, earliestAt: input.earliestAt ?? now }, now)
  if (!q.ok) {
    await db.from('gbp_posts').update({ status: 'failed', error: 'No publish slot within 14 days — check the working window and the posts cap.', updated_at: nowIso }).eq('id', postId)
    return { ok: false, error: 'No publish slot within 14 days. Check the working window and the posts cap in Settings.' }
  }
  await db.from('gbp_posts').update({ status: 'scheduled', scheduled_for: q.scheduledFor.toISOString(), push_reasons: q.pushReasons, updated_at: nowIso }).eq('id', postId)
  return { ok: true, scheduledFor: q.scheduledFor.toISOString(), pushReasons: q.pushReasons, edited }
}

export async function skipPost(db: SupabaseClient, postId: string, userId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const p = await getPost(db, postId)
  if (!['draft', 'approved', 'scheduled', 'failed'].includes(p.status)) return { ok: false, error: `This post is already ${p.status}.` }
  await cancelOutbound(db, 'gbp_post', postId, 'skipped by ' + (userId ?? 'system'))
  const { error } = await db.from('gbp_posts').update({ status: 'skipped', scheduled_for: null, updated_at: new Date().toISOString() }).eq('id', postId)
  return error ? { ok: false, error: error.message } : { ok: true }
}

/** Redraft in place from the current photos (a person asked, optionally with a note). Stays a draft. */
export async function redraftPost(db: SupabaseClient, postId: string, note: string | null, photoIds?: string[]): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const p = await getPost(db, postId)
  if (p.status !== 'draft' && p.status !== 'failed') return { ok: false, error: `Only drafts can be redrafted (this one is ${p.status}).` }
  const { loadPostDeps, buildPostContext, draftPostWithGuardrails } = await import('./post-drafter')
  const { PHOTO_SELECT } = await import('./photos')
  const ids = photoIds?.length ? photoIds.slice(0, 2) : p.photo_ids
  const [{ data: job }, { data: photos }] = await Promise.all([
    db.from('sf_jobs').select('id, number, category, description, completion_notes, city, postal_code, work_completed_at, customer_name, contact_last_name, street_1').eq('id', p.sf_job_id).maybeSingle(),
    db.from('job_photos').select(PHOTO_SELECT).in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
  ])
  if (!job) return { ok: false, error: 'Job not found' }
  const deps = await loadPostDeps(db)
  const ordered = ids.map(id => (photos ?? []).find(ph => (ph as { id: string }).id === id)).filter(Boolean) as Parameters<typeof buildPostContext>[2]
  if (!ordered.length) return { ok: false, error: 'Pick at least one photo.' }
  const ctx = await buildPostContext(db, job as Parameters<typeof buildPostContext>[1], ordered, deps)
  const out = await draftPostWithGuardrails(ctx, deps, { reviewerNote: note })
  if (!out) return { ok: false, error: 'ANTHROPIC_API_KEY is not set, so nothing can be drafted.' }
  const { data: prevRow } = await db.from('gbp_posts').select('guardrail_notes').eq('id', postId).maybeSingle()
  const prevNotes = ((prevRow as { guardrail_notes: Record<string, unknown> } | null)?.guardrail_notes ?? {}) as { previous_drafts?: string[] }
  const notes = { ...out.notes, previous_drafts: [...(prevNotes.previous_drafts ?? []), p.draft_text, ...(out.notes.previous_drafts as string[])], redraft_note: note }
  const { error } = await db.from('gbp_posts').update({ status: 'draft', draft_text: out.draft.body, final_text: null, photo_ids: ids, cta_type: ctx.cta.type, cta_url: ctx.cta.url, guardrail_notes: notes, model: out.draft.model, style_example_ids: out.draft.styleIds, error: null, updated_at: new Date().toISOString() }).eq('id', postId)
  return error ? { ok: false, error: error.message } : { ok: true, text: out.draft.body }
}

/** Change which photos a draft carries (1 or 2), without redrafting. */
export async function setPostPhotos(db: SupabaseClient, postId: string, photoIds: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const p = await getPost(db, postId)
  if (p.status !== 'draft' && p.status !== 'failed') return { ok: false, error: `Only drafts can change photos (this one is ${p.status}).` }
  const ids = photoIds.slice(0, 2)
  if (!ids.length) return { ok: false, error: 'Pick at least one photo.' }
  const { error } = await db.from('gbp_posts').update({ photo_ids: ids, updated_at: new Date().toISOString() }).eq('id', postId)
  return error ? { ok: false, error: error.message } : { ok: true }
}

/** Admin override of a photo's usability (the threshold decision). */
export async function setPhotoUsable(db: SupabaseClient, photoId: string, usable: boolean | null): Promise<void> {
  await db.from('job_photos').update({ override_usable: usable, updated_at: new Date().toISOString() }).eq('id', photoId)
}

export async function loadPostsNeedingApprovalCount(db: SupabaseClient): Promise<number> {
  const { count } = await db.from('gbp_posts').select('id', { count: 'exact', head: true }).eq('status', 'draft')
  return count ?? 0
}
