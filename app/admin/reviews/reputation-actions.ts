'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { agentDb } from '@/lib/agent/settings'
import { normalizeWindow, normalizeCtaMap, type ReplyBand, type ReputationSettings } from '@/lib/reputation/settings'
import { cancelOutbound } from '@/lib/reputation/queue'

// Admin server actions for the reputation engine (Reviews → Google Reviews reply
// panel, backlog button, and the Settings sub-tab). assertAdmin → service-role
// write → revalidate. Actions return { error } instead of throwing: in production
// Next.js replaces a thrown message with a generic one.

const PATH = '/admin/reviews'

async function assertAdmin(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/login')
  return user.id
}

export type ActionResult = { error?: string }
async function attempt<T extends object = Record<never, never>>(fn: () => Promise<T | void>): Promise<T & ActionResult> {
  try { const r = await fn(); revalidatePath(PATH); return (r ?? {}) as T & ActionResult }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) } as T & ActionResult }
}

// ── Reply panel ─────────────────────────────────────────────────────────────

export async function approveReplyAction(replyId: string, text: string): Promise<ActionResult & { scheduledFor?: string; pushReasons?: string[] }> {
  const userId = await assertAdmin()
  return attempt(async () => {
    const { approveAndSchedule } = await import('@/lib/reputation/reply-actions')
    const r = await approveAndSchedule(agentDb(), replyId, { text, userId })
    if (!r.ok) throw new Error(r.error)
    return { scheduledFor: r.scheduledFor, pushReasons: r.pushReasons }
  })
}

export async function skipReplyAction(replyId: string): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => {
    const { skipReply } = await import('@/lib/reputation/reply-actions')
    const r = await skipReply(agentDb(), replyId, userId)
    if (!r.ok) throw new Error(r.error)
  })
}

export async function redraftReplyAction(replyId: string, note: string): Promise<ActionResult & { text?: string }> {
  await assertAdmin()
  return attempt(async () => {
    const { redraftReply } = await import('@/lib/reputation/reply-actions')
    const r = await redraftReply(agentDb(), replyId, note.trim() || null)
    if (!r.ok) throw new Error(r.error)
    return { text: r.text }
  })
}

/** Draft a reply for one review on demand (a review with no draft yet). */
export async function draftNowAction(reviewId: string): Promise<ActionResult & { replyId?: string; scheduled?: boolean }> {
  await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const { loadDraftDeps, draftReplyForReview, REVIEW_SELECT } = await import('@/lib/reputation/reply-drafter')
    const { data: review } = await db.from('google_reviews').select(REVIEW_SELECT).eq('id', reviewId).maybeSingle()
    if (!review) throw new Error('Review not found')
    const deps = await loadDraftDeps(db)
    const rv = review as Parameters<typeof draftReplyForReview>[1]
    const origin = new Date(rv.ingested_at) < new Date(deps.settings.draft_since) ? 'backlog' : 'new'
    const out = await draftReplyForReview(db, rv, deps, origin)
    if (out.outcome === 'drafted' || out.outcome === 'scheduled') return { replyId: out.replyId, scheduled: out.outcome === 'scheduled' }
    if (out.outcome === 'llm_not_configured') throw new Error('ANTHROPIC_API_KEY is not set, so nothing can be drafted.')
    if (out.outcome === 'exists') throw new Error('This review already has a live draft.')
    throw new Error(('error' in out && out.error) || 'Drafting failed')
  })
}

// ── Backlog and backfill ────────────────────────────────────────────────────

export async function draftBacklogAction(input: { from: string | null; to: string | null; bands: ReplyBand[]; dailyCap: number }): Promise<ActionResult & { drafted?: number; scheduled?: number; remaining?: number; reason?: string }> {
  const userId = await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const cap = Math.max(0, Math.min(50, Math.round(input.dailyCap)))
    await db.from('reputation_settings').update({ cap_backlog_replies: cap, updated_at: new Date().toISOString(), updated_by: userId }).eq('id', 1)
    const { runBacklogDrafting } = await import('@/lib/reputation/reply-drafter')
    const r = await runBacklogDrafting(db, { from: input.from, to: input.to, bands: input.bands, limit: 25, deadline: Date.now() + 90_000 })
    if (r.reason === 'llm_not_configured') throw new Error('ANTHROPIC_API_KEY is not set, so nothing can be drafted.')
    return { drafted: r.drafted, scheduled: r.scheduled, remaining: r.remaining, reason: r.errors[0] }
  })
}

export async function backfillTagsAction(input: { force?: boolean } = {}): Promise<ActionResult & { tagged?: number; remaining?: number }> {
  await assertAdmin()
  return attempt(async () => {
    const { runTaggingPass } = await import('@/lib/reputation/tagging')
    const r = await runTaggingPass(agentDb(), { limit: 40, deadline: Date.now() + 50_000, force: input.force })
    if (r.skipped === 'llm_not_configured') throw new Error('ANTHROPIC_API_KEY is not set, so nothing can be tagged.')
    return { tagged: r.tagged, remaining: r.remaining }
  })
}

// ── Settings ────────────────────────────────────────────────────────────────

const EDITABLE: ReadonlyArray<keyof ReputationSettings> = [
  'autopilot_positive', 'autopilot_negative', 'sends_paused', 'reply_signature',
  'reply_delay_min_hours', 'reply_delay_max_hours', 'working_window', 'min_gap_minutes', 'max_gap_minutes', 'skip_hour_ratio',
  'cap_new_replies', 'cap_backlog_replies', 'cap_posts', 'ingest_interval_minutes',
  'autopilot_posts', 'cap_posts_weekly', 'post_allowed_categories', 'post_cta_map', 'photo_min_score',
]

export async function saveReputationSettings(patch: Partial<ReputationSettings>): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const row: Record<string, unknown> = {}
    for (const k of EDITABLE) if (k in patch) row[k] = patch[k]
    if ('working_window' in row) row.working_window = normalizeWindow(row.working_window)
    if ('post_cta_map' in row) row.post_cta_map = normalizeCtaMap(row.post_cta_map)
    if ('post_allowed_categories' in row) row.post_allowed_categories = (Array.isArray(row.post_allowed_categories) ? row.post_allowed_categories : []).map(c => String(c).trim()).filter(Boolean)
    const num = (k: string, lo: number, hi: number) => { if (k in row) { const v = Number(row[k]); if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} must be between ${lo} and ${hi}`); row[k] = v } }
    num('reply_delay_min_hours', 0, 72); num('reply_delay_max_hours', 0, 72)
    num('min_gap_minutes', 1, 600); num('max_gap_minutes', 1, 600); num('skip_hour_ratio', 0, 0.9)
    num('cap_new_replies', 0, 100); num('cap_backlog_replies', 0, 100); num('cap_posts', 0, 20); num('ingest_interval_minutes', 5, 1440)
    num('cap_posts_weekly', 0, 50); num('photo_min_score', 0, 100)
    if ('reply_delay_min_hours' in row && 'reply_delay_max_hours' in row && (row.reply_delay_min_hours as number) > (row.reply_delay_max_hours as number)) throw new Error('Reply delay: min must be ≤ max')
    if ('min_gap_minutes' in row && 'max_gap_minutes' in row && (row.min_gap_minutes as number) > (row.max_gap_minutes as number)) throw new Error('Gap: min must be ≤ max')
    if ('reply_signature' in row) { row.reply_signature = String(row.reply_signature).trim(); if (!row.reply_signature) throw new Error('The signature cannot be empty') }
    if (!Object.keys(row).length) return
    row.updated_at = new Date().toISOString(); row.updated_by = userId
    const { error } = await db.from('reputation_settings').update(row).eq('id', 1)
    if (error) throw new Error(error.message)

    // Same for posts: turning the posts autopilot off pulls back what it scheduled.
    if (patch.autopilot_posts === false) {
      const { data: rows } = await db.from('gbp_posts').select('id').eq('status', 'scheduled').is('approved_by', null)
      for (const r of (rows ?? []) as Array<{ id: string }>) {
        await cancelOutbound(db, 'gbp_post', r.id, 'posts autopilot switched off')
        await db.from('gbp_posts').update({ status: 'draft', approved_at: null, scheduled_for: null, push_reasons: [], updated_at: new Date().toISOString() }).eq('id', r.id)
      }
    }
    // Panic-button semantics: turning a band's autopilot off pulls back what autopilot scheduled.
    for (const band of ['positive', 'negative'] as const) {
      const key = band === 'positive' ? 'autopilot_positive' : 'autopilot_negative'
      if (patch[key] !== false) continue
      const { data: rows } = await db.from('review_replies').select('id').eq('band', band).eq('status', 'scheduled').is('approved_by', null)
      for (const r of (rows ?? []) as Array<{ id: string }>) {
        await cancelOutbound(db, 'review_reply', r.id, 'autopilot switched off')
        await db.from('review_replies').update({ status: 'draft', approved_at: null, scheduled_for: null, push_reasons: [], updated_at: new Date().toISOString() }).eq('id', r.id)
      }
    }
  })
}

export async function saveReviewCharter(body: string, note: string): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => {
    if (!body.trim()) throw new Error('The charter cannot be empty')
    const { saveCharterVersion } = await import('@/lib/agent/knowledge')
    await saveCharterVersion(agentDb(), body, note.trim() || null, userId, 'review')
  })
}
export async function activateReviewCharter(id: string): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { activateCharterVersion } = await import('@/lib/agent/knowledge'); await activateCharterVersion(agentDb(), id) })
}
export async function createReviewInstruction(text: string): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => {
    if (!text.trim()) throw new Error('Write the rule first')
    const { addInstruction } = await import('@/lib/agent/knowledge'); await addInstruction(agentDb(), text, 'review', userId)
  })
}
export async function retireReviewInstruction(id: string): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => { const { retireInstruction } = await import('@/lib/agent/knowledge'); await retireInstruction(agentDb(), id, userId) })
}
export async function reactivateReviewInstruction(id: string): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { reactivateInstruction } = await import('@/lib/agent/knowledge'); await reactivateInstruction(agentDb(), id) })
}
export async function createReviewStyleExample(input: { band: ReplyBand; inquiry_text: string; final_text: string; stars?: number | null }): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => {
    if (!input.final_text.trim()) throw new Error('Paste the reply first')
    const { addStyleExample } = await import('@/lib/agent/knowledge')
    await addStyleExample(agentDb(), { inquiry_text: input.inquiry_text || null, final_text: input.final_text, question_type: input.stars ? String(input.stars) : null, audience: `review_${input.band}`, source: 'staff' }, userId)
  })
}
export async function pinReviewStyleExample(id: string, pinned: boolean): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { setStylePinned } = await import('@/lib/agent/knowledge'); await setStylePinned(agentDb(), id, pinned) })
}
export async function removeReviewStyleExample(id: string): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { deleteStyleExample } = await import('@/lib/agent/knowledge'); await deleteStyleExample(agentDb(), id) })
}

// ── Profile posts (Phase 2) ─────────────────────────────────────────────────

export async function approvePostAction(postId: string, text: string, photoIds?: string[]): Promise<ActionResult & { scheduledFor?: string }> {
  const userId = await assertAdmin()
  return attempt(async () => {
    const { approveAndSchedulePost } = await import('@/lib/reputation/post-actions')
    const r = await approveAndSchedulePost(agentDb(), postId, { text, userId, photoIds })
    if (!r.ok) throw new Error(r.error)
    return { scheduledFor: r.scheduledFor }
  })
}
export async function skipPostAction(postId: string): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => { const { skipPost } = await import('@/lib/reputation/post-actions'); const r = await skipPost(agentDb(), postId, userId); if (!r.ok) throw new Error(r.error) })
}
export async function redraftPostAction(postId: string, note: string, photoIds?: string[]): Promise<ActionResult & { text?: string }> {
  await assertAdmin()
  return attempt(async () => { const { redraftPost } = await import('@/lib/reputation/post-actions'); const r = await redraftPost(agentDb(), postId, note.trim() || null, photoIds); if (!r.ok) throw new Error(r.error); return { text: r.text } })
}
export async function setPostPhotosAction(postId: string, photoIds: string[]): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { setPostPhotos } = await import('@/lib/reputation/post-actions'); const r = await setPostPhotos(agentDb(), postId, photoIds); if (!r.ok) throw new Error(r.error) })
}
export async function setPhotoUsableAction(photoId: string, usable: boolean | null): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { setPhotoUsable } = await import('@/lib/reputation/post-actions'); await setPhotoUsable(agentDb(), photoId, usable) })
}

/** Run the daily pass by hand for one PT day (default yesterday) or a range. */
export async function preparePostsAction(input: { dateKey?: string; from?: string; to?: string }): Promise<ActionResult & { candidates?: number; drafted?: number; scheduled?: number; noPhoto?: number; skipped?: number; reason?: string; errors?: string[] }> {
  await assertAdmin()
  return attempt(async () => {
    const { runPostPreparation } = await import('@/lib/reputation/post-drafter')
    const { ptWallToUtc, addPtDays } = await import('@/lib/reputation/pt-time')
    const opts: Parameters<typeof runPostPreparation>[1] = { deadline: Date.now() + 240_000, limit: 5 }
    if (input.from && input.to) { opts.fromIso = ptWallToUtc(input.from, 0).toISOString(); opts.toIso = ptWallToUtc(addPtDays(input.to, 1), 0).toISOString() }
    else if (input.dateKey) opts.dateKey = input.dateKey
    const r = await runPostPreparation(agentDb(), opts)
    if (r.reason === 'llm_not_configured') throw new Error('ANTHROPIC_API_KEY is not set, so nothing can be drafted.')
    return r
  })
}

/** Diagnostic: what Service Fusion returns for one job's pictures, and what we would import. */
export async function testJobPhotosAction(jobRef: string): Promise<ActionResult & { sfJobId?: string; found?: number; pictures?: Array<{ name: string | null; url: string; docType: string | null }>; rawKeys?: string[]; imported?: number; importErrors?: string[] }> {
  await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const ref = jobRef.trim()
    if (!ref) throw new Error('Enter a Service Fusion job id or job number')
    const { data: byId } = await db.from('sf_jobs').select('id').eq('id', ref).maybeSingle()
    const { data: byNum } = byId ? { data: null } : await db.from('sf_jobs').select('id').eq('number', ref).order('start_date', { ascending: false }).limit(1).maybeSingle()
    const sfJobId = ((byId ?? byNum) as { id: string } | null)?.id
    if (!sfJobId) throw new Error(`No mirrored job matches "${ref}"`)
    const { fetchJobPictures, importJobPhotos } = await import('@/lib/reputation/photos')
    const { pictures, raw } = await fetchJobPictures(sfJobId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = raw
    const job = j?.items ? j.items[0] : j
    const rawKeys = job && typeof job === 'object' ? Object.keys(job).filter(k => /pic|doc|photo|image|file/i.test(k)) : []
    const imp = await importJobPhotos(db, sfJobId)
    return { sfJobId, found: pictures.length, pictures: pictures.map(p => ({ name: p.name, url: p.fileLocation, docType: p.docType })), rawKeys, imported: imp.imported, importErrors: imp.errors }
  })
}

// Post Charter / instructions / style examples (channel 'post')
export async function savePostCharter(body: string, note: string): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => { if (!body.trim()) throw new Error('The charter cannot be empty'); const { saveCharterVersion } = await import('@/lib/agent/knowledge'); await saveCharterVersion(agentDb(), body, note.trim() || null, userId, 'post') })
}
export async function activatePostCharter(id: string): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { activateCharterVersion } = await import('@/lib/agent/knowledge'); await activateCharterVersion(agentDb(), id) })
}
export async function createPostInstruction(text: string): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => { if (!text.trim()) throw new Error('Write the rule first'); const { addInstruction } = await import('@/lib/agent/knowledge'); await addInstruction(agentDb(), text, 'post', userId) })
}
export async function createPostStyleExample(input: { final_text: string; category?: string | null }): Promise<ActionResult> {
  const userId = await assertAdmin()
  return attempt(async () => {
    if (!input.final_text.trim()) throw new Error('Paste the post first')
    const { addStyleExample } = await import('@/lib/agent/knowledge')
    await addStyleExample(agentDb(), { inquiry_text: null, final_text: input.final_text, question_type: input.category || null, audience: 'post', source: 'staff' }, userId)
  })
}
