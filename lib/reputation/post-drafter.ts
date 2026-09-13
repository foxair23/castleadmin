import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { llm, isLlmConfigured, isAdaptiveThinkingModel, describeLlmError } from '@/lib/agent/llm'
import { loadAgentSettings, type AgentSettings } from '@/lib/agent/settings'
import type { Charter, Instruction, StyleExample } from '@/lib/agent/knowledge'
import { pickStyleExamples } from '@/lib/agent/email/learning'
import { marketingUrl } from '@/lib/config/domains'
import { checkPostGuardrails, POST_LENGTH, scrubNames, serviceTermsFor, type GuardrailFailure, type GuardrailResult, type PostGuardrailContext } from './guardrails'
import { getPostCharter, listPostInstructions, listPostStyleExamples } from './knowledge'
import { importJobPhotos, pickPostPhotos, scoreJobPhotos, PHOTO_SELECT, type JobPhotoRow } from './photos'
import { addPtDays, ptDateKey, ptWallToUtc } from './pt-time'
import { loadTechRoster } from './roster'
import { ctaFor, loadReputationSettings, type ReputationSettings } from './settings'

// Profile posts from yesterday's jobs (PRD §6.4). For each finished job in an
// allowed category: import and score its photos, keep it only if a photo passed,
// draft the post from the Post Charter and the job facts (names scrubbed),
// check the guardrails, redraft once, and store a draft. With the posts
// autopilot on and every check passed, the draft is approved and handed to the
// dispatcher, which publishes it at a humanized time inside working hours.

export interface PostDeps {
  settings: ReputationSettings
  agentSettings: AgentSettings
  roster: string[]
  charter: Charter
  instructions: Instruction[]
  styles: StyleExample[]
}

export async function loadPostDeps(db: SupabaseClient): Promise<PostDeps> {
  const [settings, agentSettings, roster, charter, instructions, styles] = await Promise.all([
    loadReputationSettings(db), loadAgentSettings(db), loadTechRoster(db), getPostCharter(db), listPostInstructions(db), listPostStyleExamples(db),
  ])
  return { settings, agentSettings, roster, charter, instructions, styles }
}

export interface CandidateJob {
  id: string; number: string | null; category: string | null; description: string | null; completion_notes: string | null
  city: string | null; postal_code: string | null; work_completed_at: string; customer_name: string | null; contact_last_name: string | null; street_1: string | null
}
const JOB_SELECT = 'id, number, category, description, completion_notes, city, postal_code, work_completed_at, customer_name, contact_last_name, street_1'
const CANCELLED = ['Cancelled', 'Canceled', 'Void', 'Voided']
const DEFAULT_EXCLUDE = /warranty|estimate|service call|callback|call back|no charge|recall/i

/** Pure: is this category allowed to become a post? An empty allow-list means everything except the usual non-work categories. */
export function categoryAllowed(category: string | null, allowed: string[]): boolean {
  const cat = (category ?? '').trim()
  if (allowed.length) return allowed.some(a => a.trim().toLowerCase() === cat.toLowerCase())
  return !!cat && !DEFAULT_EXCLUDE.test(cat)
}

/** Jobs completed in a UTC window that could become posts, excluding cancelled ones and those with a live post. */
export async function findPostCandidates(db: SupabaseClient, settings: ReputationSettings, window: { fromIso: string; toIso: string }): Promise<CandidateJob[]> {
  const { data } = await db.from('sf_jobs').select(JOB_SELECT)
    .not('work_completed_at', 'is', null).gte('work_completed_at', window.fromIso).lt('work_completed_at', window.toIso)
    .gte('work_completed_at', settings.posts_since)
    .eq('is_deleted', false).not('status', 'in', `(${CANCELLED.map(s => `"${s}"`).join(',')})`)
    .order('work_completed_at', { ascending: false }).limit(300)
  const jobs = ((data ?? []) as CandidateJob[]).filter(j => categoryAllowed(j.category, settings.post_allowed_categories))
  if (!jobs.length) return []
  const { data: live } = await db.from('gbp_posts').select('sf_job_id').in('sf_job_id', jobs.map(j => j.id)).in('status', ['draft', 'approved', 'scheduled', 'published'])
  const taken = new Set(((live ?? []) as Array<{ sf_job_id: string }>).map(l => l.sf_job_id))
  return jobs.filter(j => !taken.has(j.id))
}

// ── Drafting ────────────────────────────────────────────────────────────────

const TOOL: Anthropic.Tool = {
  name: 'draft_profile_post',
  description: 'Return the text of one Google Business Profile post about a finished job. Plain text only.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['post_text', 'service_used', 'city_used', 'notes'],
    properties: {
      post_text: { type: 'string', description: `The post body only, ${POST_LENGTH[0]}–${POST_LENGTH[1]} words, 1–3 short paragraphs. No hashtags, no emoji, no signature.` },
      service_used: { type: ['string', 'null'], description: 'The service phrase you named, or null.' },
      city_used: { type: ['string', 'null'], description: 'The city or neighborhood you named, or null.' },
      notes: { type: ['string', 'null'], description: 'One line for the person reviewing this draft: anything you left out or were unsure of. Else null.' },
    },
  },
}

const RULES = `
CHANNEL: public posts on the company's Google Business Profile, shown to people searching for a garage door or gate company. Apply the charter.
Hard rules for this channel — these override anything else:
1. Never write the name of a technician, installer, or office employee. Say "our team" or "our technician".
2. Never write the customer's name, street, house number, or anything that identifies the home. City or neighborhood is fine and wanted.
3. No prices, discounts, coupons, financing, warranty or guarantee language.
4. Name the work in plain words and the city or neighborhood in the FIRST sentence.
5. Only describe what the job facts and the photos support. Do not invent materials, brands, colors, or problems.
6. No hashtags, no emoji, no all-caps words, at most one exclamation mark.
7. End with one short line that points at the button (the button label is given below). Do not write the button text itself as a link.
8. Length: ${POST_LENGTH[0]}–${POST_LENGTH[1]} words.`.trim()

function styleBlock(examples: StyleExample[]): string {
  if (!examples.length) return ''
  return '\n\nSTYLE EXAMPLES — profile posts that read the way Castle wants (match the register; never copy facts from them):\n' + examples.map(e => `---\n${e.final_text.slice(0, 700)}`).join('\n')
}

export interface PostContext {
  job: CandidateJob
  items: string[]
  photos: JobPhotoRow[]
  cta: { type: 'LEARN_MORE' | 'CALL'; url: string }
  guardrail: PostGuardrailContext
}

export async function buildPostContext(db: SupabaseClient, job: CandidateJob, photos: JobPhotoRow[], deps: PostDeps): Promise<PostContext> {
  const { data: items } = await db.from('sf_job_items').select('name').eq('sf_job_id', job.id).limit(20)
  const names = ((items ?? []) as Array<{ name: string | null }>).map(i => i.name?.trim() ?? '').filter(Boolean)
  const rule = ctaFor(deps.settings.post_cta_map, job.category)
  return {
    job: { ...job, description: scrubNames(job.description, deps.roster), completion_notes: scrubNames(job.completion_notes, deps.roster) },
    items: names, photos,
    cta: { type: rule.cta, url: `${marketingUrl()}${rule.path}` },
    guardrail: { roster: deps.roster, customerName: job.customer_name, contactLastName: job.contact_last_name, street: job.street_1, serviceTerms: serviceTermsFor(job.category, names), city: job.city },
  }
}

export function buildPostMessages(ctx: PostContext, deps: PostDeps, opts: { previous?: { text: string; failures: GuardrailFailure[] }; reviewerNote?: string | null } = {}): { system: Anthropic.TextBlockParam[]; user: string; styleIds: string[] } {
  const styles = pickStyleExamples(deps.styles, ctx.job.category ?? 'other', `${ctx.job.category ?? ''} ${ctx.items.join(' ')}`, 8)
  const instructions = deps.instructions.filter(i => i.is_active)
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: `You write Google Business Profile posts for Castle Garage Doors & Gates. Your charter:\n\n${deps.charter.body}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: RULES + (instructions.length ? `\n\nSTANDING INSTRUCTIONS from the Castle team (apply all):\n${instructions.map(i => `- ${i.text}`).join('\n')}` : '') + styleBlock(styles) },
  ]
  const facts: string[] = [`Job type: ${ctx.job.category ?? 'unknown'}`]
  if (ctx.items.length) facts.push(`Line items: ${ctx.items.slice(0, 8).join('; ')}`)
  if (ctx.job.description) facts.push(`Description: ${ctx.job.description.slice(0, 500)}`)
  if (ctx.job.completion_notes) facts.push(`Completion notes: ${ctx.job.completion_notes.slice(0, 500)}`)
  facts.push(`City: ${ctx.job.city ?? 'unknown'}`)
  facts.push(`Completed: ${ctx.job.work_completed_at.slice(0, 10)}`)
  facts.push(`Photos on the post: ${ctx.photos.map((p, i) => `${i + 1}. ${p.shows ?? 'photo'}${p.subject ? ` — ${p.subject}` : ''}`).join('; ')}`)
  facts.push(`Button label: ${ctx.cta.type === 'CALL' ? 'Call now' : 'Learn more'}`)
  let user = `JOB FACTS:\n${facts.map(f => `- ${f}`).join('\n')}\n`
  if (opts.previous) user += `\nYOUR PREVIOUS DRAFT FAILED THESE CHECKS — fix every one:\n${opts.previous.failures.map(f => `- ${f.check}: ${f.detail}`).join('\n')}\n\nPrevious draft:\n${opts.previous.text}\n`
  if (opts.reviewerNote?.trim()) user += `\nNOTE FROM THE PERSON REVIEWING THIS DRAFT: ${opts.reviewerNote.trim()}\n`
  user += `\nWrite the post now using draft_profile_post.`
  return { system, user, styleIds: styles.map(s => s.id) }
}

export interface PostDraftText { body: string; serviceUsed: string | null; cityUsed: string | null; notes: string | null; model: string; styleIds: string[] }

export async function draftPostText(ctx: PostContext, deps: PostDeps, opts: { previous?: { text: string; failures: GuardrailFailure[] }; reviewerNote?: string | null } = {}): Promise<PostDraftText | null> {
  if (!isLlmConfigured()) return null
  const { system, user, styleIds } = buildPostMessages(ctx, deps, opts)
  const model = deps.agentSettings.composer_model
  const res = await llm().messages.create({
    model, max_tokens: 1024, system, tools: [TOOL], tool_choice: { type: 'tool', name: 'draft_profile_post' },
    ...(isAdaptiveThinkingModel(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } } : {}),
    messages: [{ role: 'user', content: user }],
  })
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  if (!tu) return null
  const i = tu.input as { post_text: string; service_used: string | null; city_used: string | null; notes: string | null }
  return { body: (i.post_text ?? '').trim(), serviceUsed: i.service_used, cityUsed: i.city_used, notes: i.notes?.trim() || null, model: res.model, styleIds }
}

export async function draftPostWithGuardrails(ctx: PostContext, deps: PostDeps, opts: { reviewerNote?: string | null } = {}): Promise<{ draft: PostDraftText; result: GuardrailResult; notes: Record<string, unknown> } | null> {
  const first = await draftPostText(ctx, deps, { reviewerNote: opts.reviewerNote })
  if (!first) return null
  let draft = first
  let result = checkPostGuardrails(draft.body, ctx.guardrail)
  const previous: string[] = []
  if (!result.passed) {
    previous.push(draft.body)
    const second = await draftPostText(ctx, deps, { previous: { text: draft.body, failures: result.failures }, reviewerNote: opts.reviewerNote })
    if (second) { draft = second; result = checkPostGuardrails(draft.body, ctx.guardrail) }
  }
  return { draft, result, notes: { passed: result.passed, attempts: previous.length + 1, failures: result.failures, word_count: result.wordCount, previous_drafts: previous, model_notes: draft.notes, service_used: draft.serviceUsed, city_used: draft.cityUsed } }
}

// ── One job → one post ───────────────────────────────────────────────────────

export type PostOutcome =
  | { outcome: 'drafted' | 'scheduled'; postId: string }
  | { outcome: 'no_photo' | 'exists' | 'llm_not_configured' | 'error'; error?: string; photos?: number }

export async function preparePostForJob(db: SupabaseClient, job: CandidateJob, deps: PostDeps, opts: { skipPhotoImport?: boolean } = {}): Promise<PostOutcome> {
  if (!isLlmConfigured()) return { outcome: 'llm_not_configured' }
  try {
    if (!opts.skipPhotoImport) await importJobPhotos(db, job.id)
    await scoreJobPhotos(db, job.id, deps.agentSettings.composer_model, { category: job.category, description: job.description })
    const { data } = await db.from('job_photos').select(PHOTO_SELECT).eq('sf_job_id', job.id)
    const photos = (data ?? []) as JobPhotoRow[]
    const chosen = pickPostPhotos(photos, deps.settings.photo_min_score)
    if (!chosen.length) return { outcome: 'no_photo', photos: photos.length }
    const ctx = await buildPostContext(db, job, chosen, deps)
    const out = await draftPostWithGuardrails(ctx, deps)
    if (!out) return { outcome: 'llm_not_configured' }
    const nowIso = new Date().toISOString()
    const { data: ins, error } = await db.from('gbp_posts').insert({
      sf_job_id: job.id, location_id: process.env.GOOGLE_BUSINESS_LOCATION_ID ?? null, status: 'draft',
      photo_ids: chosen.map(p => p.id), draft_text: out.draft.body, cta_type: ctx.cta.type, cta_url: ctx.cta.url,
      guardrail_notes: out.notes, model: out.draft.model, prompt_version: deps.settings.prompt_version, charter_version: deps.charter.version,
      style_example_ids: out.draft.styleIds, created_at: nowIso, updated_at: nowIso,
    }).select('id').single()
    if (error) return error.code === '23505' ? { outcome: 'exists' } : { outcome: 'error', error: error.message }
    const postId = (ins as { id: string }).id
    if (deps.settings.autopilot_posts && out.result.passed) {
      const { approveAndSchedulePost } = await import('./post-actions')
      const r = await approveAndSchedulePost(db, postId, { text: out.draft.body, userId: null }, deps.settings)
      if (r.ok) return { outcome: 'scheduled', postId }
    }
    return { outcome: 'drafted', postId }
  } catch (e) {
    return { outcome: 'error', error: describeLlmError(e) }
  }
}

export interface PostPrepReport { candidates: number; drafted: number; scheduled: number; noPhoto: number; skipped: number; errors: string[]; reason?: string }

/**
 * The daily pass: yesterday's finished jobs (PT), best candidates first, up to
 * the daily cap of drafts, unless the weekly cap of posts is already reached.
 */
export async function runPostPreparation(db: SupabaseClient, opts: { dateKey?: string; fromIso?: string; toIso?: string; limit?: number; deadline?: number } = {}): Promise<PostPrepReport> {
  const report: PostPrepReport = { candidates: 0, drafted: 0, scheduled: 0, noPhoto: 0, skipped: 0, errors: [] }
  if (!isLlmConfigured()) return { ...report, reason: 'llm_not_configured' }
  const deps = await loadPostDeps(db)
  const deadline = opts.deadline ?? Date.now() + 240_000
  const day = opts.dateKey ?? addPtDays(ptDateKey(new Date()), -1)
  const fromIso = opts.fromIso ?? ptWallToUtc(day, 0).toISOString()
  const toIso = opts.toIso ?? ptWallToUtc(addPtDays(day, 1), 0).toISOString()

  // Weekly cap counts what is already on the calendar or published this week.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { count: weekCount } = await db.from('gbp_posts').select('id', { count: 'exact', head: true }).in('status', ['approved', 'scheduled', 'published']).gte('created_at', weekAgo)
  if ((weekCount ?? 0) >= deps.settings.cap_posts_weekly) return { ...report, reason: `weekly cap of ${deps.settings.cap_posts_weekly} reached` }

  const candidates = await findPostCandidates(db, deps.settings, { fromIso, toIso })
  report.candidates = candidates.length
  const limit = opts.limit ?? Math.max(1, deps.settings.cap_posts)
  // Prefer categories and cities not posted about in the last two weeks.
  const twoWeeks = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data: recentRows } = await db.from('gbp_posts').select('sf_job_id').gte('created_at', twoWeeks).in('status', ['approved', 'scheduled', 'published'])
  const recentIds = ((recentRows ?? []) as Array<{ sf_job_id: string }>).map(r => r.sf_job_id)
  const { data: recentJobs } = recentIds.length ? await db.from('sf_jobs').select('category, city').in('id', recentIds) : { data: [] }
  const recentCats = new Set(((recentJobs ?? []) as Array<{ category: string | null }>).map(j => (j.category ?? '').toLowerCase()))
  const recentCities = new Set(((recentJobs ?? []) as Array<{ city: string | null }>).map(j => (j.city ?? '').toLowerCase()))
  const ranked = [...candidates].sort((a, b) => {
    const score = (j: CandidateJob) => (recentCats.has((j.category ?? '').toLowerCase()) ? 0 : 2) + (recentCities.has((j.city ?? '').toLowerCase()) ? 0 : 1)
    return score(b) - score(a)
  })

  let made = 0
  for (const job of ranked) {
    if (made >= limit || Date.now() > deadline) { report.skipped++; continue }
    const out = await preparePostForJob(db, job, deps)
    if (out.outcome === 'drafted') { report.drafted++; made++ }
    else if (out.outcome === 'scheduled') { report.drafted++; report.scheduled++; made++ }
    else if (out.outcome === 'no_photo') report.noPhoto++
    else if (out.outcome === 'exists') report.skipped++
    else if (out.outcome === 'llm_not_configured') { report.reason = 'llm_not_configured'; break }
    else { report.errors.push(`${job.number ?? job.id}: ${('error' in out && out.error) || 'unknown'}`); if (report.errors.length >= 5) break }
  }
  return report
}
