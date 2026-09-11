import type { SupabaseClient } from '@supabase/supabase-js'
import type Anthropic from '@anthropic-ai/sdk'
import { llm, isLlmConfigured, isAdaptiveThinkingModel } from '@/lib/agent/llm'
import type { AgentSettings } from '@/lib/agent/settings'
import { listInstructions } from '@/lib/agent/knowledge'

// What the team tells Cassie is a conversation, not a form. One message may hold the answer
// to her question ("the install is set for the 23rd"), a rule for every future email
// ("anything marked 'waiting for Tiffany' means ask us before answering"), and something she
// still needs to ask about. This step reads a message and separates the three, so the
// facts shape this reply, the rules become standing instructions she keeps, and the
// question goes back to the thread before she drafts.

export interface Digest {
  /** Things about this job / email, to use in the reply. */
  facts: string[]
  /** General rules for future emails, each a self-contained sentence in Cassie's voice. */
  instructions: string[]
  /** What she still needs before she can write the reply, or null. */
  followUp: string | null
  /** True when she has enough to draft now. */
  readyToDraft: boolean
  /** One short line to say back in the thread. */
  acknowledgement: string
}

export interface DigestContext {
  partnerQuestion: string | null
  askedFor: string | null
  jobNumber: string | null
  currentDraft: string | null
  /** Everything said in the thread so far, oldest first, including Cassie's own follow-ups. */
  conversation: Array<{ who: string; text: string }>
  latest: { who: string; text: string }
}

const TOOL: Anthropic.Tool = {
  name: 'digest_team_message',
  description: 'Separate what a Castle team member said into facts for this reply, standing instructions for the future, and what is still missing.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      facts: { type: 'array', items: { type: 'string' }, description: 'Statements about THIS job or email that the partner reply should be based on. Verbatim meaning, no embellishment. Empty if none.' },
      instructions: { type: 'array', items: { type: 'string' }, description: 'Rules that apply to FUTURE emails too, each rewritten as one clear imperative sentence for Cassie (e.g. "When a job status says waiting for Tiffany, ask the team in chat before answering."). Empty if the message is only about this job.' },
      follow_up_question: { type: ['string', 'null'], description: 'The one thing Cassie still needs to ask the team before she can write a truthful reply, or null.' },
      ready_to_draft: { type: 'boolean', description: 'True when the facts now cover the partner question well enough to write the reply.' },
      acknowledgement: { type: 'string', description: 'One short, natural line Cassie says back in the thread (thanks, what she took from it, and the question if any). No more than two sentences.' },
    },
    required: ['facts', 'instructions', 'follow_up_question', 'ready_to_draft', 'acknowledgement'],
    additionalProperties: false,
  },
}

const SYSTEM = `You are Cassie, Castle Garage Doors' AI agent, in a Google Chat thread with your own team. You asked them for help answering a partner email. Read what a team member just said and sort it.
- A FACT is about this specific job or email. Keep the meaning exactly; do not add anything.
- An INSTRUCTION is a rule that should change how you handle future emails as well ("always", "anything marked", "never", "from now on", "when X, do Y"). Rewrite each as one clear sentence addressed to yourself. Do not turn a one-off fact into a rule.
- If what you have still does not answer the partner's question truthfully, ask ONE follow-up question — the most useful one — and say you are not ready to draft.
- If the team says to ask them / wait / let a person handle it, you are not ready to draft; set the follow-up to null only if there is nothing more to ask.
- Never invent facts. A guess from the team ("probably", "I think") is a fact to check, not to state.`

/** Read a team member's message in context. Without a model key: everything is a fact and she drafts. */
export async function digestTeamMessage(settings: AgentSettings, ctx: DigestContext): Promise<Digest> {
  if (!isLlmConfigured()) return { facts: [ctx.latest.text], instructions: [], followUp: null, readyToDraft: true, acknowledgement: `Thanks ${ctx.latest.who}.` }
  const model = settings.classifier_model
  const user = [
    ctx.partnerQuestion ? `PARTNER'S QUESTION: ${ctx.partnerQuestion}` : null,
    ctx.jobNumber ? `JOB: ${ctx.jobNumber}` : 'JOB: none matched',
    ctx.askedFor ? `WHAT I ASKED THE TEAM: ${ctx.askedFor}` : null,
    ctx.currentDraft ? `MY CURRENT DRAFT (may be wrong):\n${ctx.currentDraft.slice(0, 1500)}` : null,
    ctx.conversation.length ? `THREAD SO FAR:\n${ctx.conversation.map(m => `${m.who}: ${m.text}`).join('\n')}` : null,
    `LATEST MESSAGE — ${ctx.latest.who}: ${ctx.latest.text}`,
  ].filter(Boolean).join('\n\n')
  const res = await llm().messages.create({
    model, max_tokens: 1024, system: SYSTEM, tools: [TOOL], tool_choice: { type: 'tool', name: 'digest_team_message' },
    ...(isAdaptiveThinkingModel(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } } : {}),
    messages: [{ role: 'user', content: user }],
  })
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  if (!tu) return { facts: [ctx.latest.text], instructions: [], followUp: null, readyToDraft: true, acknowledgement: `Thanks ${ctx.latest.who}.` }
  const i = tu.input as { facts?: string[]; instructions?: string[]; follow_up_question?: string | null; ready_to_draft?: boolean; acknowledgement?: string }
  const clean = (a: unknown) => (Array.isArray(a) ? a : []).map(s => String(s).trim()).filter(Boolean)
  return {
    facts: clean(i.facts), instructions: clean(i.instructions).map(normalizeRule),
    followUp: i.follow_up_question?.trim() || null, readyToDraft: !!i.ready_to_draft,
    acknowledgement: (i.acknowledgement ?? '').trim() || `Thanks ${ctx.latest.who}.`,
  }
}

/** One sentence, first letter up, one full stop. */
export function normalizeRule(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
  return t ? t[0].toUpperCase() + t.slice(1) + '.' : ''
}
const ruleKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Which of these rules are new (not already an active instruction, allowing for punctuation / case)? */
export function newRules(candidates: string[], existing: string[]): string[] {
  const have = new Set(existing.map(ruleKey))
  const out: string[] = []
  for (const c of candidates) {
    const k = ruleKey(c)
    if (!k || have.has(k)) continue
    have.add(k); out.push(c)
  }
  return out
}

/** Save the rules Cassie learned as standing instructions, attributed to where she heard them. */
export async function saveLearnedInstructions(db: SupabaseClient, rules: string[], source: string): Promise<string[]> {
  if (!rules.length) return []
  const existing = (await listInstructions(db)).map(i => i.text)
  const fresh = newRules(rules, existing)
  for (const text of fresh) {
    const { error } = await db.from('agent_instructions').insert({ text, channel: 'all', source })
    if (error) throw new Error(error.message)
  }
  return fresh
}

export const MAX_FOLLOW_UPS = 4
