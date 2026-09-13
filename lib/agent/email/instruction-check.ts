import type Anthropic from '@anthropic-ai/sdk'
import { llm, isLlmConfigured, isAdaptiveThinkingModel } from '@/lib/agent/llm'
import type { AgentSettings } from '@/lib/agent/settings'

// A narrow second read of a draft against the team's standing instructions. The composer
// already has the rules in its prompt; this is the check a careful person does before
// sending — "did I actually follow every rule?" — done by a cheap model with nothing else
// to think about. Returns only the misses, each tied to the rule it breaks, so the
// composer's rewrite knows precisely what to change.

export interface Violation { rule: string; problem: string }

const TOOL: Anthropic.Tool = {
  name: 'report_violations',
  description: 'List every way the draft breaks a standing instruction. Empty when it follows all of them.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false, required: ['violations'],
    properties: {
      violations: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['rule', 'problem'],
          properties: {
            rule: { type: 'string', description: 'The standing instruction, quoted as given.' },
            problem: { type: 'string', description: 'What in the draft breaks it, quoting the offending words, and what to do instead. One sentence.' },
          },
        },
      },
    },
  },
}

const SYSTEM = `You check a draft email from Cassie (Castle Garage Doors & Gates' AI agent) to a partner (Home Depot, Clopay, Genie) against the Castle team's standing instructions.
Report a violation only when the draft clearly breaks an instruction — quote the words that break it. Do not invent rules, do not judge tone or style, do not report things the instructions do not cover.
Two things always count as violations even if no instruction spells them out: an internal status word or a Castle team member's name shown to the partner (e.g. "waiting for Tiffany"), and a past date presented as an upcoming appointment.
If the draft is dictated exact wording from a team member, only report an internal status word or name; a person chose the rest.`

/** The draft's misses against the instructions. Empty on no model key, on no rules, or on any error — the check must never block a reply. */
export async function checkInstructions(settings: AgentSettings, input: { draft: string; instructions: string[]; exactWording?: string | null }): Promise<Violation[]> {
  if (!isLlmConfigured() || !input.draft.trim()) return []
  const model = settings.classifier_model
  const user = `STANDING INSTRUCTIONS:\n${input.instructions.length ? input.instructions.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)'}\n\n${input.exactWording ? `The draft is dictated exact wording from a team member.\n\n` : ''}DRAFT TO THE PARTNER:\n${input.draft.slice(0, 4000)}\n\nReport violations with report_violations.`
  const res = await llm().messages.create({
    model, max_tokens: 800, system: SYSTEM, tools: [TOOL], tool_choice: { type: 'tool', name: 'report_violations' },
    ...(isAdaptiveThinkingModel(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } } : {}),
    messages: [{ role: 'user', content: user }],
  })
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  const v = (tu?.input as { violations?: Array<{ rule?: string; problem?: string }> } | undefined)?.violations ?? []
  return v.filter(x => x?.problem?.trim()).map(x => ({ rule: String(x.rule ?? '').trim(), problem: String(x.problem).trim() })).slice(0, 6)
}
