import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { llm, isLlmConfigured, describeLlmError } from '@/lib/agent/llm'
import { loadAgentSettings } from '@/lib/agent/settings'
import { bandFor } from './settings'

// AI tags on every Google review (PRD §5 item 2): sentiment, themes from a fixed
// list, the service mentioned, names the reviewer wrote, and any neighborhood.
// One short classifier call per review at sync; a backfill button covers the
// history. The tags feed Insights and the reply guardrails (mentioned names).

export const THEMES = ['punctuality', 'price_value', 'communication', 'quality_of_work', 'cleanliness', 'professionalism', 'scheduling', 'warranty_follow_up', 'emergency_response'] as const
export const SERVICE_TAGS = ['garage_door_repair', 'garage_door_install', 'opener_repair', 'opener_install', 'spring_replacement', 'cable_or_roller', 'panel_replacement', 'gate_repair', 'gate_install', 'gate_opener', 'maintenance_tuneup', 'commercial', 'other'] as const
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const

export type Theme = typeof THEMES[number]
export type ServiceTag = typeof SERVICE_TAGS[number]
export type Sentiment = typeof SENTIMENTS[number]

export interface ReviewTags {
  sentiment: Sentiment
  themes: Theme[]
  service_tags: ServiceTag[]
  mentioned_names: string[]
  neighborhood: string | null
}

const TOOL: Anthropic.Tool = {
  name: 'tag_review',
  description: 'Classify one Google review of a garage door and gate company for reporting.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['sentiment', 'themes', 'service_tags', 'mentioned_names', 'neighborhood'],
    properties: {
      sentiment: { type: 'string', enum: [...SENTIMENTS] },
      themes: { type: 'array', items: { type: 'string', enum: [...THEMES] }, description: 'Every theme the text actually speaks to. Empty if none.' },
      service_tags: { type: 'array', items: { type: 'string', enum: [...SERVICE_TAGS] }, description: 'The work described, as best as the text says. Empty if unclear.' },
      mentioned_names: { type: 'array', items: { type: 'string' }, description: 'Person names the reviewer wrote, exactly as written (first names count). Not the business name.' },
      neighborhood: { type: ['string', 'null'], description: 'A city, neighborhood or area named in the text, as written. Else null.' },
    },
  },
}

const MAX = 10
const pick = <T extends string>(arr: unknown, allowed: readonly T[]): T[] => {
  if (!Array.isArray(arr)) return []
  const out: T[] = []
  for (const v of arr) if (typeof v === 'string' && (allowed as readonly string[]).includes(v) && !out.includes(v as T)) out.push(v as T)
  return out.slice(0, MAX)
}

/** Pure: keep only known values, dedupe, trim, cap. */
export function normalizeTags(raw: unknown): ReviewTags {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const names: string[] = []
  if (Array.isArray(r.mentioned_names)) {
    for (const n of r.mentioned_names) {
      const t = typeof n === 'string' ? n.trim().replace(/\s+/g, ' ') : ''
      if (t && t.length <= 60 && !names.some(x => x.toLowerCase() === t.toLowerCase())) names.push(t)
    }
  }
  const nb = typeof r.neighborhood === 'string' ? r.neighborhood.trim() : ''
  return {
    sentiment: (SENTIMENTS as readonly string[]).includes(r.sentiment as string) ? (r.sentiment as Sentiment) : 'neutral',
    themes: pick(r.themes, THEMES),
    service_tags: pick(r.service_tags, SERVICE_TAGS),
    mentioned_names: names.slice(0, MAX),
    neighborhood: nb && nb.length <= 60 ? nb : null,
  }
}

/** Tags for one review. Empty comments are tagged from the stars without an API call. */
export async function tagReview(comment: string | null, starRating: number, model: string): Promise<{ tags: ReviewTags; model: string } | null> {
  const text = comment?.trim() ?? ''
  if (!text) {
    return { tags: { sentiment: bandFor(starRating) === 'positive' ? 'positive' : 'negative', themes: [], service_tags: [], mentioned_names: [], neighborhood: null }, model: 'stars-only' }
  }
  if (!isLlmConfigured()) return null
  const res = await llm().messages.create({
    model, max_tokens: 400,
    tools: [TOOL], tool_choice: { type: 'tool', name: 'tag_review' },
    system: 'You tag Google reviews of Castle Garage Doors & Gates, a garage door and gate installer in San Diego County. Read literally; tag only what the text says.',
    messages: [{ role: 'user', content: `Star rating: ${starRating}\n\nReview:\n${text.slice(0, 4000)}` }],
  })
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  if (!tu) return null
  return { tags: normalizeTags(tu.input), model: res.model }
}

export interface TaggingReport { tagged: number; remaining: number; skipped?: string; errors: string[] }

/** Tag untagged reviews (or everything with force), oldest first, within a time budget. Safe to re-run. */
export async function runTaggingPass(db: SupabaseClient, opts: { limit?: number; deadline?: number; force?: boolean } = {}): Promise<TaggingReport> {
  const limit = opts.limit ?? 40
  const deadline = opts.deadline ?? Date.now() + 40_000
  const report: TaggingReport = { tagged: 0, remaining: 0, errors: [] }
  if (!isLlmConfigured()) return { ...report, skipped: 'llm_not_configured' }
  const model = (await loadAgentSettings(db)).classifier_model

  let q = db.from('google_reviews').select('id, comment, star_rating', { count: 'exact' }).is('deleted_at', null).order('created_at_google', { ascending: true }).limit(limit)
  if (!opts.force) q = q.is('ai_tagged_at', null)
  const { data, count } = await q
  const rows = (data ?? []) as Array<{ id: string; comment: string | null; star_rating: number }>
  report.remaining = Math.max(0, (count ?? rows.length) - rows.length)

  for (const r of rows) {
    if (Date.now() > deadline) { report.remaining += rows.length - report.tagged; break }
    try {
      const out = await tagReview(r.comment, r.star_rating, model)
      if (!out) continue
      await db.from('google_reviews').update({
        ai_sentiment: out.tags.sentiment, ai_themes: out.tags.themes, ai_service_tags: out.tags.service_tags,
        ai_mentioned_names: out.tags.mentioned_names, ai_neighborhood: out.tags.neighborhood,
        ai_tagged_at: new Date().toISOString(), ai_tag_model: out.model,
      }).eq('id', r.id)
      report.tagged++
    } catch (e) {
      report.errors.push(`${r.id}: ${describeLlmError(e)}`)
      if (report.errors.length >= 5) break
    }
  }
  return report
}
