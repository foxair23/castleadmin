'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { agentDb } from '@/lib/agent/settings'
import { normalizeWindow, normalizeCtaMap, type ReplyBand, type ReputationSettings } from '@/lib/reputation/settings'
import type { CandidateBreakdown } from '@/lib/reputation/post-drafter'
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
  'autopilot_posts', 'cap_posts_weekly', 'post_allowed_categories', 'post_cta_map', 'photo_min_score', 'posts_since',
  'rank_scans_enabled', 'rank_business_match', 'rank_weekly_request_cap', 'rank_default_keywords',
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
    // The posts start date is edited as a PT calendar day; store the PT midnight that begins it.
    if ('posts_since' in row) {
      const raw = String(row.posts_since ?? '').trim()
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) { const { ptWallToUtc } = await import('@/lib/reputation/pt-time'); row.posts_since = ptWallToUtc(raw, 0).toISOString() }
      else if (Number.isNaN(Date.parse(raw))) throw new Error('The posts start date is not a valid date')
      else row.posts_since = new Date(raw).toISOString()
    }
    const num = (k: string, lo: number, hi: number) => { if (k in row) { const v = Number(row[k]); if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} must be between ${lo} and ${hi}`); row[k] = v } }
    num('reply_delay_min_hours', 0, 72); num('reply_delay_max_hours', 0, 72)
    num('min_gap_minutes', 1, 600); num('max_gap_minutes', 1, 600); num('skip_hour_ratio', 0, 0.9)
    num('cap_new_replies', 0, 100); num('cap_backlog_replies', 0, 100); num('cap_posts', 0, 20); num('ingest_interval_minutes', 5, 1440)
    num('cap_posts_weekly', 0, 50); num('photo_min_score', 0, 100); num('rank_weekly_request_cap', 0, 50000)
    if ('rank_business_match' in row) { row.rank_business_match = String(row.rank_business_match).trim().toLowerCase(); if (!row.rank_business_match) throw new Error('The business match text cannot be empty') }
    if ('rank_default_keywords' in row) row.rank_default_keywords = (Array.isArray(row.rank_default_keywords) ? row.rank_default_keywords : []).map(k => String(k).trim().toLowerCase()).filter(Boolean)
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
/** Bulk import of owner replies from a CSV export (see lib/reputation/style-import.ts). Rows are already parsed and filtered in the browser. */
export async function importReviewStyleExamples(rows: Array<{ stars: number | null; review: string | null; reply: string; business: string | null }>): Promise<ActionResult & { added?: number; duplicates?: number; positive?: number; negative?: number }> {
  const userId = await assertAdmin()
  return attempt(async () => {
    if (!rows.length) throw new Error('Nothing to import')
    if (rows.length > 1000) throw new Error('Import at most 1000 rows at a time')
    const db = agentDb()
    const { bandForStars } = await import('@/lib/reputation/style-import')
    const { REVIEW_AUDIENCES } = await import('@/lib/reputation/knowledge')
    const { data: existing } = await db.from('agent_style_examples').select('final_text').in('audience', REVIEW_AUDIENCES).eq('is_deleted', false).limit(5000)
    const seen = new Set(((existing ?? []) as Array<{ final_text: string }>).map(e => e.final_text.toLowerCase().replace(/\s+/g, ' ').trim()))
    const inserts: Array<Record<string, unknown>> = []
    let duplicates = 0, positive = 0, negative = 0
    for (const r of rows) {
      const reply = String(r.reply ?? '').trim()
      if (!reply) continue
      const key = reply.toLowerCase().replace(/\s+/g, ' ')
      if (seen.has(key)) { duplicates++; continue }
      seen.add(key)
      const band = bandForStars(r.stars)
      if (band === 'positive') positive++; else negative++
      inserts.push({
        source: 'import', audience: `review_${band}`, question_type: r.stars != null ? String(r.stars) : null,
        inquiry_text: r.review ? String(r.review).trim().slice(0, 2000) || null : null, final_text: reply.slice(0, 2000), created_by: userId,
      })
    }
    for (let i = 0; i < inserts.length; i += 200) {
      const { error } = await db.from('agent_style_examples').insert(inserts.slice(i, i + 200))
      if (error) throw new Error(error.message)
    }
    return { added: inserts.length, duplicates, positive, negative }
  })
}
/** Soft-delete every example that came in through the CSV import (one band, or both). */
export async function removeImportedStyleExamples(band?: ReplyBand): Promise<ActionResult & { removed?: number }> {
  await assertAdmin()
  return attempt(async () => {
    const { REVIEW_AUDIENCES, audienceFor } = await import('@/lib/reputation/knowledge')
    const { data, error } = await agentDb().from('agent_style_examples').update({ is_deleted: true, is_pinned: false })
      .eq('source', 'import').eq('is_deleted', false).in('audience', band ? [audienceFor(band)] : REVIEW_AUDIENCES).select('id')
    if (error) throw new Error(error.message)
    return { removed: (data ?? []).length }
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
export async function preparePostsAction(input: { dateKey?: string; from?: string; to?: string }): Promise<ActionResult & { candidates?: number; drafted?: number; scheduled?: number; noPhoto?: number; skipped?: number; reason?: string; errors?: string[]; breakdown?: CandidateBreakdown }> {
  await assertAdmin()
  return attempt(async () => {
    const { runPostPreparation } = await import('@/lib/reputation/post-drafter')
    const { ptWallToUtc, addPtDays } = await import('@/lib/reputation/pt-time')
    // Days the owner named explicitly are considered whatever the posts start date says; that rail is for the morning pass.
    const opts: Parameters<typeof runPostPreparation>[1] = { deadline: Date.now() + 240_000, limit: 5, ignorePostsSince: true }
    if (input.from && input.to) { opts.fromIso = ptWallToUtc(input.from, 0).toISOString(); opts.toIso = ptWallToUtc(addPtDays(input.to, 1), 0).toISOString() }
    else if (input.dateKey) opts.dateKey = input.dateKey
    const r = await runPostPreparation(agentDb(), opts)
    if (r.reason === 'llm_not_configured') throw new Error('ANTHROPIC_API_KEY is not set, so nothing can be drafted.')
    return r
  })
}

/** Diagnostic: what Service Fusion returns for one job's pictures, what the raw objects look like, and which file endpoints answer. */
export async function testJobPhotosAction(jobRef: string): Promise<ActionResult & {
  sfJobId?: string; found?: number; pictures?: Array<{ name: string | null; url: string; docType: string | null }>; rawKeys?: string[]
  samples?: string[]; probes?: Array<{ what: string; result: string }>; absoluteUrls?: number; imported?: number; importErrors?: string[]
  stored?: number
}> {
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
    const rawList: unknown[] = Array.isArray(job?.pictures) ? job.pictures : Array.isArray(job?.pictures?.items) ? job.pictures.items : []
    const samples = rawList.slice(0, 2).map(o => JSON.stringify(o, null, 1).slice(0, 700))

    const probes: Array<{ what: string; result: string }> = []
    const { resolvePictureUrl } = await import('@/lib/reputation/photos')
    const absoluteUrls = pictures.length
    const imp = await importJobPhotos(db, sfJobId)
    const { count: stored } = await db.from('job_photos').select('id', { count: 'exact', head: true }).eq('sf_job_id', sfJobId).not('storage_path', 'is', null)
    return { sfJobId, found: pictures.length, pictures: pictures.map(p => ({ name: p.name, url: resolvePictureUrl(p.fileLocation), docType: p.docType })), rawKeys, samples, probes, absoluteUrls, imported: imp.imported, importErrors: imp.errors, stored: stored ?? 0 }
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

// ── Rank tracking (Phase 3) ─────────────────────────────────────────────────

export async function addPlaceAction(input: { name: string; query?: string; lat?: number | null; lng?: number | null; zips?: string; kind?: 'city' | 'zip' | 'pin' }): Promise<ActionResult & { placeId?: string; lat?: number; lng?: number; label?: string }> {
  await assertAdmin()
  return attempt(async () => {
    const name = input.name.trim()
    if (!name) throw new Error('Give the place a name')
    let lat = input.lat ?? null, lng = input.lng ?? null, kind = input.kind ?? 'city', label = name
    if (lat == null || lng == null) {
      const { geocode } = await import('@/lib/rank/geocode')
      const hit = await geocode(input.query?.trim() || name)
      if (!hit) throw new Error(`Could not find "${input.query || name}" on the map. Try "City, CA", a ZIP, or "lat, lng".`)
      lat = hit.lat; lng = hit.lng; kind = hit.kind; label = hit.label
    }
    const zips = (input.zips ?? '').split(/[\s,]+/).map(z => z.trim()).filter(z => /^\d{5}$/.test(z))
    const { data, error } = await agentDb().from('rank_places').upsert({ name, kind, lat, lng, zips, is_active: true, updated_at: new Date().toISOString() }, { onConflict: 'name' }).select('id').single()
    if (error) throw new Error(error.message)
    return { placeId: data.id as string, lat, lng, label }
  })
}
export async function updatePlaceAction(id: string, patch: { name?: string; lat?: number; lng?: number; zips?: string; is_active?: boolean }): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.name != null) { row.name = patch.name.trim(); if (!row.name) throw new Error('Name cannot be empty') }
    if (patch.lat != null) row.lat = Number(patch.lat)
    if (patch.lng != null) row.lng = Number(patch.lng)
    if (patch.zips != null) row.zips = patch.zips.split(/[\s,]+/).map(z => z.trim()).filter(z => /^\d{5}$/.test(z))
    if (patch.is_active != null) row.is_active = patch.is_active
    const { error } = await agentDb().from('rank_places').update(row).eq('id', id)
    if (error) throw new Error(error.message)
  })
}
export async function removePlaceAction(id: string): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { error } = await agentDb().from('rank_places').delete().eq('id', id); if (error) throw new Error(error.message) })
}

export async function addMonitorsAction(input: { placeId: string; keywords: string[]; gridSize: number; spacingMiles?: number }): Promise<ActionResult & { added?: number }> {
  await assertAdmin()
  return attempt(async () => {
    const keywords = [...new Set(input.keywords.map(k => k.trim().toLowerCase()).filter(Boolean))]
    if (!keywords.length) throw new Error('Add at least one keyword')
    if (![1, 3, 5, 7, 9].includes(input.gridSize)) throw new Error('Grid must be 1, 3, 5, 7 or 9')
    const rows = keywords.map(keyword => ({ place_id: input.placeId, keyword, grid_size: input.gridSize, spacing_miles: input.spacingMiles ?? 1, is_active: true, updated_at: new Date().toISOString() }))
    const { error } = await agentDb().from('rank_monitors').upsert(rows, { onConflict: 'place_id,keyword' })
    if (error) throw new Error(error.message)
    return { added: rows.length }
  })
}
/** Every active place × the default keywords, as 3×3 mini-grids. Existing monitors are left alone. */
export async function addStarterMonitorsAction(): Promise<ActionResult & { added?: number; places?: number }> {
  await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const { loadReputationSettings } = await import('@/lib/reputation/settings')
    const s = await loadReputationSettings(db)
    const { data: places } = await db.from('rank_places').select('id').eq('is_active', true)
    const rows = ((places ?? []) as Array<{ id: string }>).flatMap(p => s.rank_default_keywords.map(keyword => ({ place_id: p.id, keyword, grid_size: 3, spacing_miles: 1, is_active: true, updated_at: new Date().toISOString() })))
    if (!rows.length) throw new Error('No active places and/or no default keywords')
    const { error } = await db.from('rank_monitors').upsert(rows, { onConflict: 'place_id,keyword', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
    return { added: rows.length, places: (places ?? []).length }
  })
}
export async function setMonitorActiveAction(id: string, active: boolean): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { error } = await agentDb().from('rank_monitors').update({ is_active: active, updated_at: new Date().toISOString() }).eq('id', id); if (error) throw new Error(error.message) })
}
export async function removeMonitorAction(id: string): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => { const { error } = await agentDb().from('rank_monitors').delete().eq('id', id); if (error) throw new Error(error.message) })
}
/** Scan one monitor right now (counts against the weekly cap only by being recorded as a weekly scan for this week). */
export async function scanMonitorNowAction(id: string): Promise<ActionResult & { scanId?: string; avgRank?: number | null; foundShare?: number; requests?: number; cost?: number }> {
  await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const { MONITOR_SELECT, runScan } = await import('@/lib/rank/scan')
    const { data } = await db.from('rank_monitors').select(MONITOR_SELECT).eq('id', id).maybeSingle()
    const m = data as unknown as { id: string; place_id: string; keyword: string; grid_size: number; spacing_miles: number; place: { lat: number; lng: number } | null } | null
    if (!m?.place) throw new Error('Monitor not found')
    const r = await runScan(db, { keyword: m.keyword, center: { lat: m.place.lat, lng: m.place.lng }, gridSize: m.grid_size, spacingMiles: Number(m.spacing_miles), source: 'weekly', monitorId: m.id, placeId: m.place_id }, undefined, { deadline: Date.now() + 240_000 })
    if (r.status === 'failed') throw new Error(r.error ?? 'Scan failed')
    return { scanId: r.scanId, avgRank: r.avgRank, foundShare: r.foundShare, requests: r.requests, cost: r.cost }
  })
}
/** Check now: keyword at a typed location (place name, ZIP, address, or "lat, lng"), single point or a small grid. Saved as a live scan. */
export async function liveCheckAction(input: { keyword: string; location: string; gridSize: number; placeId?: string | null }): Promise<ActionResult & { scanId?: string; label?: string; avgRank?: number | null; foundShare?: number; requests?: number; cost?: number }> {
  await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const keyword = input.keyword.trim().toLowerCase()
    if (!keyword) throw new Error('Enter a keyword')
    if (![1, 3, 5, 7].includes(input.gridSize)) throw new Error('Grid must be 1, 3, 5 or 7')
    let center: { lat: number; lng: number } | null = null, label = input.location.trim(), placeId = input.placeId ?? null
    if (placeId) {
      const { data: p } = await db.from('rank_places').select('name, lat, lng').eq('id', placeId).maybeSingle()
      if (p) { center = { lat: p.lat as number, lng: p.lng as number }; label = p.name as string }
    }
    if (!center) {
      const { geocode } = await import('@/lib/rank/geocode')
      const hit = await geocode(input.location)
      if (!hit) throw new Error(`Could not find "${input.location}" on the map. Try "City, CA", a ZIP, or "lat, lng".`)
      center = { lat: hit.lat, lng: hit.lng }; label = hit.label; placeId = null
    }
    const { runScan } = await import('@/lib/rank/scan')
    const r = await runScan(db, { keyword, center, gridSize: input.gridSize, spacingMiles: 1, source: 'live', placeId }, undefined, { deadline: Date.now() + 240_000 })
    if (r.status === 'failed') throw new Error(r.error ?? 'Check failed')
    return { scanId: r.scanId, label, avgRank: r.avgRank, foundShare: r.foundShare, requests: r.requests, cost: r.cost }
  })
}
/** Turn a live check into a monitored entry: creates the place from the scan center if needed. */
export async function monitorFromScanAction(scanId: string, placeName: string): Promise<ActionResult & { monitorId?: string }> {
  await assertAdmin()
  return attempt(async () => {
    const db = agentDb()
    const { data: scan } = await db.from('rank_scans').select('keyword, center_lat, center_lng, grid_size, place_id').eq('id', scanId).maybeSingle()
    if (!scan) throw new Error('Scan not found')
    let placeId = scan.place_id as string | null
    if (!placeId) {
      const name = placeName.trim(); if (!name) throw new Error('Name the place first')
      const { data: p, error } = await db.from('rank_places').upsert({ name, kind: 'pin', lat: scan.center_lat, lng: scan.center_lng, is_active: true, updated_at: new Date().toISOString() }, { onConflict: 'name' }).select('id').single()
      if (error) throw new Error(error.message)
      placeId = p.id as string
    }
    const grid = [1, 3, 5, 7, 9].includes(scan.grid_size as number) ? (scan.grid_size as number) : 3
    const { data: m, error } = await db.from('rank_monitors').upsert({ place_id: placeId, keyword: scan.keyword, grid_size: grid, spacing_miles: 1, is_active: true, updated_at: new Date().toISOString() }, { onConflict: 'place_id,keyword' }).select('id').single()
    if (error) throw new Error(error.message)
    await db.from('rank_scans').update({ monitor_id: m.id, place_id: placeId }).eq('id', scanId)
    return { monitorId: m.id as string }
  })
}
export async function upsertAreaPageAction(input: { placeId: string; url: string; pageUpdatedAt?: string | null; notes?: string | null }): Promise<ActionResult> {
  await assertAdmin()
  return attempt(async () => {
    const url = input.url.trim()
    if (!url) { const { error } = await agentDb().from('area_pages').delete().eq('place_id', input.placeId); if (error) throw new Error(error.message); return }
    const { error } = await agentDb().from('area_pages').upsert({ place_id: input.placeId, url, page_updated_at: input.pageUpdatedAt || null, notes: input.notes?.trim() || null, updated_at: new Date().toISOString() }, { onConflict: 'place_id' })
    if (error) throw new Error(error.message)
  })
}
export async function rankProviderStatusAction(): Promise<ActionResult & { configured?: boolean; balance?: number | null }> {
  await assertAdmin()
  return attempt(async () => {
    const { isRankProviderConfigured, providerBalance } = await import('@/lib/rank/dataforseo')
    return { configured: isRankProviderConfigured(), balance: await providerBalance() }
  })
}

// ── Google profile performance ──────────────────────────────────────────────

/** "Fetch now" on the Insights tab: pull the last 30 days of profile performance from Google. */
export async function syncPerformanceAction(): Promise<ActionResult & { rows?: number; days?: number }> {
  await assertAdmin()
  return attempt(async () => {
    const { isConfigured } = await import('@/lib/google-reviews/gbp-client')
    if (!isConfigured()) throw new Error('Google Business Profile is not connected (GOOGLE_* environment variables).')
    const { syncPerformance } = await import('@/lib/google-reviews/performance')
    const r = await syncPerformance(agentDb(), { days: 30 })
    if (!r.ok) throw new Error(r.error ?? 'Sync failed')
    return { rows: r.rows, days: r.days }
  })
}

/** "Pull full history" on the Insights tab: everything Google keeps (about 18 months), one time. */
export async function backfillPerformanceAction(): Promise<ActionResult & { rows?: number; days?: number; from?: string; to?: string }> {
  await assertAdmin()
  return attempt(async () => {
    const { isConfigured } = await import('@/lib/google-reviews/gbp-client')
    if (!isConfigured()) throw new Error('Google Business Profile is not connected (GOOGLE_* environment variables).')
    const { backfillPerformance } = await import('@/lib/google-reviews/performance')
    const r = await backfillPerformance(agentDb(), { months: 18, deadline: Date.now() + 240_000 })
    if (!r.ok) throw new Error(r.error ?? 'Backfill failed')
    return { rows: r.rows, days: r.days, from: r.from, to: r.to }
  })
}

// ── Post style examples from a CSV of other profiles' posts ─────────────────

/** Import posts scraped from other businesses' profiles as post style examples, each tagged with the closest Castle job category by the AI. */
export async function importPostStyleExamples(rows: Array<{ text: string; business: string | null }>): Promise<ActionResult & { added?: number; duplicates?: number; categorized?: number }> {
  const userId = await assertAdmin()
  return attempt(async () => {
    if (!rows.length) throw new Error('Nothing to import')
    if (rows.length > 100) throw new Error('Import at most 100 rows per call')
    const db = agentDb()
    const { POST_AUDIENCE } = await import('@/lib/reputation/knowledge')
    const { data: existing } = await db.from('agent_style_examples').select('final_text').eq('audience', POST_AUDIENCE).eq('is_deleted', false).limit(5000)
    const seen = new Set(((existing ?? []) as Array<{ final_text: string }>).map(e => e.final_text.toLowerCase().replace(/\s+/g, ' ').trim()))
    const fresh: Array<{ text: string; business: string | null }> = []
    let duplicates = 0
    for (const r of rows) {
      const text = String(r.text ?? '').trim()
      if (!text) continue
      const key = text.toLowerCase().replace(/\s+/g, ' ')
      if (seen.has(key)) { duplicates++; continue }
      seen.add(key); fresh.push({ text, business: r.business ? String(r.business).trim().slice(0, 120) || null : null })
    }
    if (!fresh.length) return { added: 0, duplicates, categorized: 0 }
    const { data: catRows } = await db.from('sf_job_categories').select('name').eq('is_deleted', false)
    const categories = [...new Set(((catRows ?? []) as Array<{ name: string | null }>).map(c => (c.name ?? '').trim()).filter(Boolean))]
    const { categorizePosts } = await import('@/lib/reputation/post-categorize')
    const { loadAgentSettings } = await import('@/lib/agent/settings')
    const model = (await loadAgentSettings(db)).classifier_model
    const cats = await categorizePosts(fresh.map(f => f.text), categories, model).catch(() => fresh.map(() => null))
    const inserts = fresh.map((f, i) => ({
      source: 'import', audience: POST_AUDIENCE, question_type: cats[i], inquiry_text: f.business, final_text: f.text.slice(0, 2000), created_by: userId,
    }))
    const { error } = await db.from('agent_style_examples').insert(inserts)
    if (error) throw new Error(error.message)
    return { added: inserts.length, duplicates, categorized: cats.filter(Boolean).length }
  })
}

/** Soft-delete every post example that came in through the CSV import. */
export async function removeImportedPostStyleExamples(): Promise<ActionResult & { removed?: number }> {
  await assertAdmin()
  return attempt(async () => {
    const { POST_AUDIENCE } = await import('@/lib/reputation/knowledge')
    const { data, error } = await agentDb().from('agent_style_examples').update({ is_deleted: true, is_pinned: false })
      .eq('source', 'import').eq('is_deleted', false).eq('audience', POST_AUDIENCE).select('id')
    if (error) throw new Error(error.message)
    return { removed: (data ?? []).length }
  })
}
