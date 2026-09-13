import type Anthropic from '@anthropic-ai/sdk'
import { llm, isLlmConfigured, isAdaptiveThinkingModel } from '@/lib/agent/llm'
import type { AgentSettings, QuestionType } from '@/lib/agent/settings'
import type { Charter, Instruction, StyleExample } from '@/lib/agent/knowledge'
import type { Fact } from './grounding'
import type { ComposedClaim } from './grounding-check'

// Stage 4 — compose the reply (PRD §5, §8). The composer sees: the charter (stable,
// cached), the channel rules, active standing instructions, a few style examples,
// the numbered fact list, and the thread. It returns STRUCTURED output: a list of
// sentences, each with the fact ids it relies on. Free text never comes back —
// grounding-check.ts verifies every concrete value in every sentence against the
// cited facts, in code.

export interface ComposeInput {
  settings: AgentSettings
  charter: Charter
  instructions: Instruction[]
  styleExamples: StyleExample[]
  facts: Fact[]
  gaps: string[]
  questionType: QuestionType
  questionSummary: string
  partner: { fromName: string | null; fromAddr: string; company: string }
  subject: string
  /** The inquiry with quoted history removed. */
  body: string
  /** Earlier messages in the thread, oldest first, already trimmed. */
  thread: Array<{ from: string; text: string }>
  /** From the self-check: what the previous draft got wrong against the standing
   *  instructions. The rewrite must fix every one. */
  reviewNotes?: string[]
}

export interface ComposeOutput {
  claims: ComposedClaim[]
  /** Model's own flag that it could not answer the core question from the facts. */
  couldNotAnswer: boolean
  /** What it would have needed — becomes the Chat ask / coverage-log entry. */
  missing: string | null
  model: string
  usage: { input: number; output: number; cacheRead: number }
}

const CHANNEL_RULES = `
CHANNEL: partner email (Home Depot store staff, Clopay and Genie contacts). Apply the charter's partner sections.
Hard rules for this channel — these override anything else:
1. Every sentence that states a date, time, status, name, number, or amount MUST cite the fact ids it comes from. If no fact supports a statement, do not make it. Say plainly what you do not see instead ("I don't see a confirmed ship date yet.").
2. Never assign fault to Home Depot, Clopay, Genie, a technician, or a customer.
3. Do not discuss pricing, invoices, warranty terms, or contracts. Do not agree to a reschedule or any change; a person will handle that.
4. Never deny being an AI. Do not open by announcing you are one either — the signature block covers disclosure and is added after you.
5. No humor in this channel. No apologies unless something actually went wrong on our side and a fact says so. No pleasantries beyond one short line.
6. Answer first, context second. Match the sender's length: a two-line question gets a two-line answer.
7. Use the sender's terminology (PO, measure, install, site check). Say "our technician", "our team" — never "the service provider".
8. Do not include a greeting line or sign-off name; those are added around your sentences. Do not include the signature.
9. Do not ask the sender for information already in the email or the thread.
10. If the facts do not answer the question, set could_not_answer = true and describe what is missing in one line. Still write the best honest reply you can (what you do see, and that the team will follow up).
11. The standing instructions may tell you to check with the team in certain situations (a status word, a date that has already passed, a kind of request). When one applies, set could_not_answer = true and put what you would ask the team in "missing" — do not answer around it.
12. A fact labelled EXACT WORDING is the reply itself, dictated by a Castle team member. Use it as the body — the same sentences, in order, minus greeting and sign-off. Do not add sentences, soften it, or restate it; only split it into the sentence list and cite that fact.
13. Internal status words and names from our system (a status like "waiting for Tiffany", a team member's name, a note to ourselves) never go to a partner. Say what it means for them in plain terms, or check with the team (rule 11).
14. Before returning, re-read every standing instruction and check each sentence against it. If REVIEW NOTES are given, they name what the last draft got wrong — every one must be fixed.`.trim()

const TOOL: Anthropic.Tool = {
  name: 'compose_reply',
  description: 'Return the reply as an ordered list of sentences, each with the fact ids it relies on.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['sentences', 'could_not_answer', 'missing'],
    properties: {
      sentences: {
        type: 'array',
        description: 'The reply body, one sentence per item, in order. Paragraph breaks: set new_paragraph on the first sentence of a new paragraph.',
        items: {
          type: 'object', additionalProperties: false, required: ['text', 'fact_ids', 'new_paragraph'],
          properties: {
            text: { type: 'string' },
            fact_ids: { type: 'array', items: { type: 'string' }, description: 'Ids like "F3" of every fact this sentence relies on. Empty only for sentences with no factual content.' },
            new_paragraph: { type: 'boolean' },
          },
        },
      },
      could_not_answer: { type: 'boolean', description: 'True if the core question cannot be answered from the facts provided.' },
      missing: { type: ['string', 'null'], description: 'If could_not_answer, the specific thing you would need (one line). Else null.' },
    },
  },
}

function styleBlock(examples: StyleExample[]): string {
  if (!examples.length) return ''
  return '\nSTYLE EXAMPLES — how Castle actually writes to partners (match the register, do not copy facts from them):\n' +
    examples.slice(0, 8).map(e => `${e.inquiry_text ? `Partner: ${e.inquiry_text}\n` : ''}Castle: ${e.final_text}`).join('\n---\n')
}

export function buildComposeMessages(input: ComposeInput): { system: Anthropic.TextBlockParam[]; user: string } {
  const instructions = input.instructions.filter(i => i.is_active && (i.channel === 'all' || i.channel === 'email'))
  const system: Anthropic.TextBlockParam[] = [
    // Stable across every call → cache it. Charter changes rarely.
    { type: 'text', text: `You are Cassie, the AI agent for Castle Garage Doors & Gates. Your charter:\n\n${input.charter.body}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: CHANNEL_RULES + (instructions.length ? `\n\nSTANDING INSTRUCTIONS from the Castle team (apply all):\n${instructions.map(i => `- ${i.text}`).join('\n')}` : '') + styleBlock(input.styleExamples) },
  ]
  const factList = input.facts.length
    ? input.facts.map(f => `${f.id} [${f.label}]: ${f.text}`).join('\n')
    : '(no facts available — nothing was matched)'
  const thread = input.thread.length
    ? `\nEARLIER IN THIS THREAD (oldest first):\n${input.thread.map(m => `[${m.from}]\n${m.text}`).join('\n\n')}\n`
    : ''
  const user = `FACTS YOU MAY USE (cite by id):\n${factList}\n${input.gaps.length ? `\nGAPS (things we looked for and did not find — say so plainly if asked):\n${input.gaps.map(g => `- ${g}`).join('\n')}\n` : ''}${thread}
INQUIRY from ${input.partner.fromName ?? input.partner.fromAddr} (${input.partner.company}), subject "${input.subject}":
${input.body}

Question type: ${input.questionType}. In one line: ${input.questionSummary}
${input.reviewNotes?.length ? `\nREVIEW NOTES — your previous draft broke these standing instructions; fix every one:\n${input.reviewNotes.map(n => `- ${n}`).join('\n')}\n` : ''}
Compose the reply now using compose_reply.`
  return { system, user }
}

export async function composeReply(input: ComposeInput): Promise<ComposeOutput | null> {
  if (!isLlmConfigured()) return null
  const { system, user } = buildComposeMessages(input)
  const model = input.settings.composer_model
  const res = await llm().messages.create({
    model,
    max_tokens: 2048,
    system,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'compose_reply' },
    ...(isAdaptiveThinkingModel(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'medium' as const } } : {}),
    messages: [{ role: 'user', content: user }],
  })
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  if (!tu) return null
  const i = tu.input as { sentences: Array<{ text: string; fact_ids: string[]; new_paragraph: boolean }>; could_not_answer: boolean; missing: string | null }
  const claims: ComposedClaim[] = (i.sentences ?? []).filter(s => s.text?.trim()).map(s => ({
    text: (s.new_paragraph ? '\n' : '') + s.text.trim(),
    factIds: (s.fact_ids ?? []).map(String),
  }))
  return {
    claims,
    couldNotAnswer: !!i.could_not_answer,
    missing: i.missing?.trim() || null,
    model: res.model,
    usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0 },
  }
}

/** Sentences → the email body. Paragraph markers become blank lines. */
export function renderBody(claims: ComposedClaim[]): string {
  let out = ''
  for (const c of claims) {
    const t = c.text
    if (t.startsWith('\n')) out += (out ? '\n\n' : '') + t.slice(1)
    else out += (out ? ' ' : '') + t
  }
  return out.trim()
}

/** Greeting + body + disclosure block, per PRD §8. */
export function renderEmail(body: string, settings: AgentSettings, partnerFirstName: string | null): string {
  const hi = partnerFirstName ? `Hi ${partnerFirstName},` : 'Hi,'
  return `${hi}\n\n${body}\n\nCassie\nCastle Garage Doors & Gates\n\n—\n${settings.signature_text}\n${settings.escape_hatch_text}`
}
