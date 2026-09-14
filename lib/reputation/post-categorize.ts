import type Anthropic from '@anthropic-ai/sdk'
import { llm, isLlmConfigured } from '@/lib/agent/llm'

// When posts from other companies' profiles are imported as style examples,
// each one is tagged with the closest Castle job category (the names mirrored
// from Service Fusion), so the drafter can prefer examples of the same kind of
// work. Repair posts from a plumber still teach the shape of a good repair
// post. One call per batch; a post that fits nothing stays untagged.

const TOOL: Anthropic.Tool = {
  name: 'assign_categories',
  description: 'For each numbered post, name the one job category from the allowed list that best matches the kind of work described, or null when none fits.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false, required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['index', 'category'], properties: { index: { type: 'integer' }, category: { type: ['string', 'null'] } } },
      },
    },
  },
}

/** Pure: the tool output → one category (or null) per input index. Unknown names and bad indexes are dropped. */
export function normalizeAssignments(raw: unknown, count: number, categories: string[]): Array<string | null> {
  const out: Array<string | null> = Array.from({ length: count }, () => null)
  const byLower = new Map(categories.map(c => [c.toLowerCase().trim(), c]))
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { assignments?: unknown }).assignments) ? (raw as { assignments: unknown[] }).assignments : []
  for (const a of list as Array<Record<string, unknown>>) {
    const i = Number(a.index)
    if (!Number.isInteger(i) || i < 0 || i >= count) continue
    const c = typeof a.category === 'string' ? byLower.get(a.category.toLowerCase().trim()) ?? null : null
    out[i] = c
  }
  return out
}

const BATCH = 25

/** The closest Castle category for each post text. Returns all nulls without an API key. */
export async function categorizePosts(texts: string[], categories: string[], model: string): Promise<Array<string | null>> {
  if (!texts.length || !categories.length || !isLlmConfigured()) return texts.map(() => null)
  const out: Array<string | null> = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const res = await llm().messages.create({
      model, max_tokens: 1500,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'assign_categories' },
      system: `You sort Google Business Profile posts written by home-service companies (any trade) into the job categories of Castle Garage Doors & Gates, a garage door and gate company. Match on the KIND of work (a repair, a new installation, routine maintenance, an emergency call, an opener or motor, a gate) rather than the trade. Allowed categories, use the exact spelling:\n${categories.map(c => `- ${c}`).join('\n')}\nUse null when a post is not about a job at all (holiday greeting, hiring, promotion).`,
      messages: [{ role: 'user', content: batch.map((t, j) => `#${j}\n${t.slice(0, 1500)}`).join('\n\n') }],
    })
    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    out.push(...normalizeAssignments(tu?.input, batch.length, categories))
  }
  return out
}
