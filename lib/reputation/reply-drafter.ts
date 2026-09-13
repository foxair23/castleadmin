import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { llm, isLlmConfigured, isAdaptiveThinkingModel, describeLlmError } from '@/lib/agent/llm'
import { loadAgentSettings, type AgentSettings } from '@/lib/agent/settings'
import type { Charter, Instruction, StyleExample } from '@/lib/agent/knowledge'
import { pickStyleExamples } from '@/lib/agent/email/learning'
import { checkReplyGuardrails, LENGTH_BANDS, type GuardrailContext, type GuardrailFailure, type GuardrailResult } from './guardrails'
import { getReviewCharter, listReviewInstructions, listReviewStyleExamples, audienceFor } from './knowledge'
import { buildReplyContext, type ReplyContext, type ReviewForContext } from './reply-context'
import { loadTechRoster } from './roster'
import { autopilotOn, loadReputationSettings, type ReplyBand, type ReplyOrigin, type ReputationSettings } from './settings'

// The reply drafter (PRD §4.2): Claude writes the body from the Reply Charter,
// the review, the job facts and a few style examples; the guardrails check it;
// one redraft on failure; the row lands in review_replies as a draft — or, when
// the band's autopilot switch is on and the checks passed, straight into the
// send queue at a humanized time.

export interface DraftDeps {
  settings: ReputationSettings
  agentSettings: AgentSettings
  roster: string[]
  charter: Charter
  instructions: Instruction[]
  styles: StyleExample[]
}

export async function loadDraftDeps(db: SupabaseClient): Promise<DraftDeps> {
  const [settings, agentSettings, roster, charter, instructions, styles] = await Promise.all([
    loadReputationSettings(db), loadAgentSettings(db), loadTechRoster(db), getReviewCharter(db), listReviewInstructions(db), listReviewStyleExamples(db),
  ])
  return { settings, agentSettings, roster, charter, instructions, styles }
}

const TOOL: Anthropic.Tool = {
  name: 'draft_review_reply',
  description: 'Return the owner reply body for one Google review. Plain text, no signature.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['reply_text', 'service_type_used', 'city_used', 'tone', 'notes'],
    properties: {
      reply_text: { type: 'string', description: 'The reply body only: 1–3 short paragraphs of plain text. No greeting line beyond the reviewer first name, no sign-off, no signature.' },
      service_type_used: { type: ['string', 'null'], description: 'The service phrase you worked in (e.g. "garage door spring replacement"), or null if none was known.' },
      city_used: { type: ['string', 'null'], description: 'The city or neighborhood you mentioned, or null.' },
      tone: { type: 'string', enum: ['grateful', 'apologetic', 'neutral'] },
      notes: { type: ['string', 'null'], description: 'One line for the person reviewing this draft: anything you deliberately left out or were unsure of. Else null.' },
    },
  },
}

function channelRules(ctx: ReplyContext): string {
  const band = ctx.band === 'positive' ? (ctx.hasJob ? LENGTH_BANDS.positive : LENGTH_BANDS.positiveNoJob) : (ctx.hasJob ? LENGTH_BANDS.negative : LENGTH_BANDS.negativeNoJob)
  return `
CHANNEL: public owner replies to Google reviews, posted under the business name. Apply the charter.
Hard rules for this channel — these override anything else:
1. Never write the name of any technician, installer, or office employee, first or last, even if the reviewer wrote it. Say "our technician" or "our team".
2. Never write the customer's last name, street, or anything that identifies their home. The reviewer's first name is fine, once, if one is given.
3. No prices, discounts, invoices, warranty or guarantee language, refunds, credits, or promises about future work or cost.
4. Never argue, dispute, correct, or explain away. On a 1–3 star review: thank them, acknowledge plainly, apologize once for the experience, say we want to make it right, and invite them to call the office at (800) 576-1397.
5. Name the service in plain words and the city or neighborhood when the facts give them. Weave them in naturally; never list them.
6. Do not repeat the star rating. Do not mention that you are replying late, even to an old review.
7. Do not invent anything. If there are no job facts, write from the review text alone.
8. Do not write a greeting line like "Hi Sarah," on its own; do not write a sign-off, a name, or a signature. Those are added after you.
9. Length: ${band[0]}–${band[1]} words. Short review, short reply.`.trim()
}

function styleBlock(examples: StyleExample[]): string {
  if (!examples.length) return ''
  return '\n\nSTYLE EXAMPLES — how Castle actually replies (match the register; never copy facts or names from them):\n' +
    examples.map(e => `${e.inquiry_text ? `Review: ${e.inquiry_text.slice(0, 400)}\n` : ''}Castle: ${e.final_text.slice(0, 600)}`).join('\n---\n')
}

export function buildDraftMessages(ctx: ReplyContext, deps: DraftDeps, opts: { previous?: { text: string; failures: GuardrailFailure[] }; reviewerNote?: string | null } = {}): { system: Anthropic.TextBlockParam[]; user: string; styleIds: string[] } {
  const styles = pickStyleExamples(deps.styles.filter(s => s.audience === audienceFor(ctx.band)), String(ctx.starRating), ctx.comment ?? '', 12)
  const instructions = deps.instructions.filter(i => i.is_active)
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: `You write Google review replies for Castle Garage Doors & Gates. Your charter:\n\n${deps.charter.body}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: channelRules(ctx) + (instructions.length ? `\n\nSTANDING INSTRUCTIONS from the Castle team (apply all):\n${instructions.map(i => `- ${i.text}`).join('\n')}` : '') + styleBlock(styles) },
  ]
  const facts: string[] = [
    `Stars: ${ctx.starRating} of 5 (${ctx.band === 'positive' ? 'positive' : 'negative or mixed'})`,
    `Reviewer first name: ${ctx.reviewerFirstName ?? '(none shown — do not use a name)'}`,
    `Review age: ${ctx.reviewAgeDays} days`,
    `Review text: ${ctx.comment ?? '(no text — a star rating only)'}`,
  ]
  if (ctx.job) {
    facts.push(`JOB (from our records, confident match):`)
    if (ctx.job.category) facts.push(`- Job type: ${ctx.job.category}`)
    if (ctx.job.items.length) facts.push(`- Line items: ${ctx.job.items.slice(0, 8).join('; ')}`)
    if (ctx.job.description) facts.push(`- Description: ${ctx.job.description.slice(0, 500)}`)
    if (ctx.job.completionNotes) facts.push(`- Completion notes: ${ctx.job.completionNotes.slice(0, 500)}`)
    if (ctx.job.city) facts.push(`- City: ${ctx.job.city}`)
  } else {
    facts.push(`JOB: no job facts available. Write from the review text alone.`)
    if (ctx.guardrail.neighborhood) facts.push(`- The reviewer mentioned: ${ctx.guardrail.neighborhood}`)
  }
  let user = `FACTS:\n${facts.join('\n')}\n`
  if (opts.previous) {
    user += `\nYOUR PREVIOUS DRAFT FAILED THESE CHECKS — fix every one:\n${opts.previous.failures.map(f => `- ${f.check}: ${f.detail}`).join('\n')}\n\nPrevious draft:\n${opts.previous.text}\n`
  }
  if (opts.reviewerNote?.trim()) user += `\nNOTE FROM THE PERSON REVIEWING THIS DRAFT: ${opts.reviewerNote.trim()}\n`
  user += `\nWrite the reply now using draft_review_reply.`
  return { system, user, styleIds: styles.map(s => s.id) }
}

export interface DraftText { body: string; serviceUsed: string | null; cityUsed: string | null; tone: string; notes: string | null; model: string; styleIds: string[] }

export async function draftReplyText(ctx: ReplyContext, deps: DraftDeps, opts: { previous?: { text: string; failures: GuardrailFailure[] }; reviewerNote?: string | null } = {}): Promise<DraftText | null> {
  if (!isLlmConfigured()) return null
  const { system, user, styleIds } = buildDraftMessages(ctx, deps, opts)
  const model = deps.agentSettings.composer_model
  const res = await llm().messages.create({
    model, max_tokens: 1024, system,
    tools: [TOOL], tool_choice: { type: 'tool', name: 'draft_review_reply' },
    ...(isAdaptiveThinkingModel(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } } : {}),
    messages: [{ role: 'user', content: user }],
  })
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  if (!tu) return null
  const i = tu.input as { reply_text: string; service_type_used: string | null; city_used: string | null; tone: string; notes: string | null }
  return { body: (i.reply_text ?? '').trim(), serviceUsed: i.service_type_used, cityUsed: i.city_used, tone: i.tone, notes: i.notes?.trim() || null, model: res.model, styleIds }
}

export const renderReplyBody = (body: string, signature: string): string => `${body.trim()}\n\n— ${signature.trim()}`

export function guardrailContextFor(ctx: ReplyContext, deps: DraftDeps, review: { reviewer_name: string | null; ai_mentioned_names?: string[] | null }): GuardrailContext {
  return {
    band: ctx.band, hasJob: ctx.hasJob, roster: deps.roster, reviewerName: review.reviewer_name,
    signature: deps.settings.reply_signature, mentionedNames: review.ai_mentioned_names ?? [],
    ...ctx.guardrail,
  }
}

/** Draft → check → one redraft → check. Returns the final body and the notes to store. */
export async function draftWithGuardrails(ctx: ReplyContext, deps: DraftDeps, gctx: GuardrailContext, opts: { reviewerNote?: string | null } = {}): Promise<{ draft: DraftText; result: GuardrailResult; notes: Record<string, unknown> } | null> {
  const first = await draftReplyText(ctx, deps, { reviewerNote: opts.reviewerNote })
  if (!first) return null
  let draft = first
  let result = checkReplyGuardrails(draft.body, gctx)
  const previous: string[] = []
  if (!result.passed) {
    previous.push(draft.body)
    const second = await draftReplyText(ctx, deps, { previous: { text: draft.body, failures: result.failures }, reviewerNote: opts.reviewerNote })
    if (second) { draft = second; result = checkReplyGuardrails(draft.body, gctx) }
  }
  const notes = {
    passed: result.passed, attempts: previous.length + 1, failures: result.failures, word_count: result.wordCount,
    previous_drafts: previous, model_notes: draft.notes, service_used: draft.serviceUsed, city_used: draft.cityUsed, tone: draft.tone,
  }
  return { draft, result, notes }
}

export interface ReviewRow extends ReviewForContext {
  google_review_id: string
  ingested_at: string
  reply_text: string | null
}

export const REVIEW_SELECT = 'id, google_review_id, reviewer_name, star_rating, comment, created_at_google, ingested_at, matched_job_id, match_status, ai_neighborhood, ai_mentioned_names, reply_text'

export type DraftOutcome =
  | { outcome: 'drafted' | 'scheduled'; replyId: string }
  | { outcome: 'exists' | 'llm_not_configured' | 'error'; error?: string }

/** Draft one review's reply and store it; schedule it when the band's autopilot is on and the checks passed. */
export async function draftReplyForReview(db: SupabaseClient, review: ReviewRow, deps: DraftDeps, origin: ReplyOrigin): Promise<DraftOutcome> {
  if (!isLlmConfigured()) return { outcome: 'llm_not_configured' }
  try {
    const ctx = await buildReplyContext(db, review, deps.roster)
    const gctx = guardrailContextFor(ctx, deps, review)
    const out = await draftWithGuardrails(ctx, deps, gctx)
    if (!out) return { outcome: 'llm_not_configured' }
    const text = renderReplyBody(out.draft.body, deps.settings.reply_signature)
    const now = new Date().toISOString()
    const { data, error } = await db.from('review_replies').insert({
      google_review_id: review.id, band: ctx.band, origin, draft_text: text, status: 'draft',
      guardrail_notes: out.notes, model: out.draft.model, prompt_version: deps.settings.prompt_version,
      charter_version: deps.charter.version, style_example_ids: out.draft.styleIds, created_at: now, updated_at: now,
    }).select('id').single()
    if (error) {
      if (error.code === '23505') return { outcome: 'exists' }
      return { outcome: 'error', error: error.message }
    }
    const replyId = (data as { id: string }).id
    if (autopilotOn(deps.settings, ctx.band) && out.result.passed) {
      const { approveAndSchedule } = await import('./reply-actions')
      const earliest = origin === 'new'
        ? new Date(new Date(review.ingested_at).getTime() + (deps.settings.reply_delay_min_hours + Math.random() * Math.max(0, deps.settings.reply_delay_max_hours - deps.settings.reply_delay_min_hours)) * 3_600_000)
        : new Date()
      const res = await approveAndSchedule(db, replyId, { text, userId: null, earliestAt: earliest }, deps.settings)
      if (res.ok) return { outcome: 'scheduled', replyId }
    }
    return { outcome: 'drafted', replyId }
  } catch (e) {
    return { outcome: 'error', error: describeLlmError(e) }
  }
}

export interface DraftingReport { drafted: number; scheduled: number; skipped: number; remaining: number; errors: string[]; reason?: string }

async function liveReplyIds(db: SupabaseClient, reviewIds: string[]): Promise<Set<string>> {
  if (!reviewIds.length) return new Set()
  const { data } = await db.from('review_replies').select('google_review_id').in('google_review_id', reviewIds).in('status', ['draft', 'approved', 'scheduled', 'posted'])
  return new Set(((data ?? []) as Array<{ google_review_id: string }>).map(r => r.google_review_id))
}

async function draftMany(db: SupabaseClient, rows: ReviewRow[], origin: ReplyOrigin, limit: number, deadline: number): Promise<DraftingReport> {
  const report: DraftingReport = { drafted: 0, scheduled: 0, skipped: 0, remaining: 0, errors: [] }
  if (!rows.length) return report
  if (!isLlmConfigured()) return { ...report, remaining: rows.length, reason: 'llm_not_configured' }
  const deps = await loadDraftDeps(db)
  let handled = 0
  for (const r of rows) {
    if (handled >= limit || Date.now() > deadline) break
    handled++
    const out = await draftReplyForReview(db, r, deps, origin)
    if (out.outcome === 'drafted') report.drafted++
    else if (out.outcome === 'scheduled') { report.drafted++; report.scheduled++ }
    else if (out.outcome === 'exists') report.skipped++
    else if (out.outcome === 'llm_not_configured') { report.reason = 'llm_not_configured'; break }
    else { report.errors.push(`${r.google_review_id}: ${'error' in out ? out.error ?? 'unknown' : 'unknown'}`); if (report.errors.length >= 5) break }
  }
  report.remaining = rows.length - handled
  return report
}

/** New reviews since draft_since with no reply on Google and no live draft. Runs after every sync. */
export async function runNewDraftingPass(db: SupabaseClient, opts: { limit?: number; deadline?: number } = {}): Promise<DraftingReport> {
  const limit = opts.limit ?? 10
  const deadline = opts.deadline ?? Date.now() + 60_000
  const settings = await loadReputationSettings(db)
  const { data } = await db.from('google_reviews').select(REVIEW_SELECT)
    .is('deleted_at', null).is('reply_text', null).gte('ingested_at', settings.draft_since)
    .order('ingested_at', { ascending: true }).limit(limit * 3)
  const all = (data ?? []) as ReviewRow[]
  const live = await liveReplyIds(db, all.map(r => r.id))
  return draftMany(db, all.filter(r => !live.has(r.id)), 'new', limit, deadline)
}

/** The "Draft replies for old reviews" button: unreplied historical reviews, oldest first. */
export async function runBacklogDrafting(db: SupabaseClient, opts: { from?: string | null; to?: string | null; bands: ReplyBand[]; limit?: number; deadline?: number }): Promise<DraftingReport> {
  const limit = opts.limit ?? 25
  const deadline = opts.deadline ?? Date.now() + 90_000
  const stars = [...(opts.bands.includes('positive') ? [4, 5] : []), ...(opts.bands.includes('negative') ? [1, 2, 3] : [])]
  if (!stars.length) return { drafted: 0, scheduled: 0, skipped: 0, remaining: 0, errors: [] }
  let q = db.from('google_reviews').select(REVIEW_SELECT).is('deleted_at', null).is('reply_text', null).in('star_rating', stars)
    .order('created_at_google', { ascending: true }).limit(1000)
  if (opts.from) q = q.gte('created_at_google', opts.from)
  if (opts.to) q = q.lte('created_at_google', `${opts.to}T23:59:59Z`)
  const { data } = await q
  const all = (data ?? []) as ReviewRow[]
  const live = await liveReplyIds(db, all.map(r => r.id))
  return draftMany(db, all.filter(r => !live.has(r.id)), 'backlog', limit, deadline)
}
