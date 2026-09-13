import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isConfigured, fetchAllReviews, type GbpReview } from './gbp-client'
import { MOCK_REVIEWS } from './mock-data'
import { runMatchingPass } from './matcher'
import { verifyPostedReplies } from '@/lib/reputation/verify'
import { importPreExistingReplies } from '@/lib/reputation/knowledge'
import { runTaggingPass } from '@/lib/reputation/tagging'
import { runNewDraftingPass } from '@/lib/reputation/reply-drafter'

// The one Google-review sync used by both the cron and the admin "Sync & Match"
// button (they used to carry two copies of this loop). Order:
//   fetch → upsert → verify posted replies → match → import pre-existing replies
//   → AI-tag → draft replies. Every stage is try/caught so one failure never
//   blocks the next, and the run is recorded in review_sync_runs.

// Patterns that indicate an anonymous / no-name reviewer (spec §6.3)
const ANONYMOUS_PATTERNS = [/^a google user$/i, /^google user$/i, /^anonymous$/i]
export function isAnonymous(name: string | null): boolean {
  if (!name || !name.trim()) return true
  return ANONYMOUS_PATTERNS.some(p => p.test(name.trim()))
}

export function reviewsDb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface IngestReport {
  ok: boolean
  skipped?: string
  reviewsSeen: number; reviewsNew: number; reviewsUpdated: number
  matched: number; candidates: number; noMatch: number
  verified: number; imported: number; tagged: number; drafted: number; scheduled: number
  errors: string[]
}

export interface IngestOptions {
  trigger: 'cron' | 'admin'
  /** Wall-clock budget for the whole run; the tag and draft stages stop when it is spent. */
  budgetMs: number
  stages?: { match?: boolean; tag?: boolean; draft?: boolean }
}

export async function runIngestPipeline(opts: IngestOptions, db: SupabaseClient = reviewsDb()): Promise<IngestReport> {
  const started = Date.now()
  const deadline = started + opts.budgetMs
  const stages = { match: true, tag: true, draft: true, ...(opts.stages ?? {}) }
  const report: IngestReport = { ok: true, reviewsSeen: 0, reviewsNew: 0, reviewsUpdated: 0, matched: 0, candidates: 0, noMatch: 0, verified: 0, imported: 0, tagged: 0, drafted: 0, scheduled: 0, errors: [] }

  const { data: run } = await db.from('review_sync_runs').insert({ status: 'running' }).select('id').single()
  const runId = (run as { id: string } | null)?.id
  const finish = async (status: 'completed' | 'failed') => {
    if (!runId) return
    await db.from('review_sync_runs').update({
      status, ended_at: new Date().toISOString(),
      reviews_seen: report.reviewsSeen, reviews_new: report.reviewsNew, reviews_updated: report.reviewsUpdated,
      errors_json: report.errors.length ? report.errors : null,
    }).eq('id', runId)
  }

  // ── 1. Fetch (live or mock) ───────────────────────────────────────────────
  let reviews: GbpReview[] = []
  const touched: Array<{ id: string; reply_text: string | null }> = []
  try {
    const live = isConfigured()
    if (live) reviews = await fetchAllReviews()
    else {
      // Mock data seeds once; afterwards the later stages still run so dev can
      // exercise tagging and drafting on the seeded rows.
      const { count } = await db.from('google_reviews').select('id', { count: 'exact', head: true })
      reviews = (count ?? 0) > 0 ? [] : MOCK_REVIEWS
      if ((count ?? 0) > 0) report.skipped = 'mock data already seeded'
    }
    report.reviewsSeen = reviews.length

    // ── 2. Upsert ───────────────────────────────────────────────────────────
    for (const r of reviews) {
      try {
        const { data: existing } = await db.from('google_reviews')
          .select('id, updated_at_google, reply_text, reply_updated_at')
          .eq('google_review_id', r.googleReviewId).maybeSingle()
        const ex = existing as { id: string; updated_at_google: string; reply_text: string | null; reply_updated_at: string | null } | null
        const nowIso = new Date().toISOString()
        if (!ex) {
          const { data: ins } = await db.from('google_reviews').insert({
            google_review_id: r.googleReviewId, reviewer_name: r.reviewerName, star_rating: r.starRating, comment: r.comment,
            created_at_google: r.createdAtGoogle, updated_at_google: r.updatedAtGoogle,
            reply_text: r.replyText, reply_updated_at: r.replyUpdatedAt,
            reply_source: r.replyText ? 'pre_existing' : null,
            match_status: isAnonymous(r.reviewerName) ? 'anonymous' : 'pending_review',
            raw_payload: r.rawPayload, last_synced_at: nowIso,
          }).select('id').single()
          if (ins) touched.push({ id: (ins as { id: string }).id, reply_text: r.replyText })
          report.reviewsNew++
        } else {
          const reviewChanged = new Date(r.updatedAtGoogle) > new Date(ex.updated_at_google)
          // Google keeps the reply's own updateTime; a reply appearing or changing
          // does not bump the review's updateTime, so compare the reply separately.
          const replyChanged = (r.replyText ?? null) !== (ex.reply_text ?? null) || (r.replyUpdatedAt ?? null) !== (ex.reply_updated_at ?? null)
          const updates: Record<string, unknown> = { last_synced_at: nowIso }
          if (reviewChanged) { updates.updated_at_google = r.updatedAtGoogle; updates.raw_payload = r.rawPayload }
          if (replyChanged) {
            updates.reply_text = r.replyText; updates.reply_updated_at = r.replyUpdatedAt
            // A reply we did not post arrived (someone answered in Google directly);
            // one we did post is reconciled by verifyPostedReplies below.
            if (r.replyText && !ex.reply_text) {
              const { count } = await db.from('review_replies').select('id', { count: 'exact', head: true }).eq('google_review_id', ex.id).in('status', ['posted', 'verified'])
              if ((count ?? 0) === 0) updates.reply_source = 'manual'
            }
            if (!r.replyText) updates.reply_source = null
          }
          await db.from('google_reviews').update(updates).eq('google_review_id', r.googleReviewId)
          touched.push({ id: ex.id, reply_text: r.replyText })
          if (reviewChanged || replyChanged) report.reviewsUpdated++
        }
      } catch (err) {
        report.errors.push(`${r.googleReviewId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    const msg = `Ingest failed: ${err instanceof Error ? err.message : String(err)}`
    report.errors.push(msg)
    report.ok = false
    await finish('failed')
    return report
  }

  // ── 3. Verify replies we posted ─────────────────────────────────────────
  try { report.verified = (await verifyPostedReplies(db, touched)).verified } catch (err) { report.errors.push(`verify: ${msg(err)}`) }

  // ── 4. Match ────────────────────────────────────────────────────────────
  if (stages.match) {
    try { const m = await runMatchingPass(); report.matched = m.matched; report.candidates = m.candidates; report.noMatch = m.noMatch }
    catch (err) { report.errors.push(`matching: ${msg(err)}`) }
  }

  // ── 5. Pre-existing replies → style examples (no-op after the first run) ─
  try {
    const { data: s } = await db.from('reputation_settings').select('pre_existing_imported_at').eq('id', 1).maybeSingle()
    if (!(s as { pre_existing_imported_at: string | null } | null)?.pre_existing_imported_at) {
      report.imported = await importPreExistingReplies(db)
      await db.from('reputation_settings').update({ pre_existing_imported_at: new Date().toISOString() }).eq('id', 1)
    }
  } catch (err) { report.errors.push(`import: ${msg(err)}`) }

  // ── 6. AI tags ──────────────────────────────────────────────────────────
  if (stages.tag && Date.now() < deadline) {
    try {
      const t = await runTaggingPass(db, { limit: opts.trigger === 'cron' ? 40 : 10, deadline: Math.min(deadline, Date.now() + (opts.trigger === 'cron' ? 60_000 : 20_000)) })
      report.tagged = t.tagged; report.errors.push(...t.errors.map(e => `tag: ${e}`))
    } catch (err) { report.errors.push(`tagging: ${msg(err)}`) }
  }

  // ── 7. Draft replies ────────────────────────────────────────────────────
  if (stages.draft && Date.now() < deadline) {
    try {
      const d = await runNewDraftingPass(db, { limit: opts.trigger === 'cron' ? 10 : 5, deadline })
      report.drafted = d.drafted; report.scheduled = d.scheduled; report.errors.push(...d.errors.map(e => `draft: ${e}`))
    } catch (err) { report.errors.push(`drafting: ${msg(err)}`) }
  }

  report.ok = !(report.errors.length > 0 && report.reviewsNew + report.reviewsUpdated === 0 && report.reviewsSeen > 0)
  await finish(report.ok ? 'completed' : 'failed')
  return report
}

const msg = (err: unknown) => err instanceof Error ? err.message : String(err)
