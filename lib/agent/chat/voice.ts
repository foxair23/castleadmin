import { llm, isLlmConfigured, isAdaptiveThinkingModel } from '@/lib/agent/llm'
import type { AgentSettings } from '@/lib/agent/settings'

// How Cassie sounds in Google Chat. Every message she posts to the team goes through here,
// so it reads like a coworker typing — not a form with labels. The model writes it from a
// handful of facts; if there is no model key, a plain fallback line is used instead.

const VOICE = `You are Cassie, a member of the Castle Garage Doors & Gates team, typing a message to coworkers in Google Chat.
Sound like a person: casual, warm, direct. Contractions are fine. No headers, no "Label: value" lines, no bullet lists unless you are listing several rules. One short paragraph, two at most.
Say what's up, what you need (or did), and what you'll do next. Mention the job number and PO once, naturally. Do not invent anything beyond the facts given. Do not sign off. Do not mention that you are an AI.`

export type ChatPurpose = 'ask' | 'reviewer_ask' | 'reminder' | 'timed_out' | 'noted_rules' | 'draft_ready' | 'left_to_person'

export interface VoiceFacts {
  purpose: ChatPurpose
  partner?: string | null          // "DC St. Louis (Clopay)"
  partnerAsked?: string | null
  jobNumber?: string | null
  need?: string | null             // what she needs, or the question she is asking
  reviewer?: string | null         // who sent her here, when it came from the review page
  rules?: string[]
  who?: string | null              // who answered
  extra?: string | null
}

function fallback(f: VoiceFacts): string {
  const job = f.jobNumber ? ` (job ${f.jobNumber})` : ''
  switch (f.purpose) {
    case 'ask': return `Hey team — ${f.partner ?? 'a partner'} is asking: ${f.partnerAsked ?? 'a status question'}${job}. ${f.need ?? 'I need a hand with this one.'} Reply here (mention @Cassie) and I'll write back to them.`
    case 'reviewer_ask': return `${f.reviewer ?? 'A reviewer'} asked me to check with you on ${f.partner ?? 'a partner'}'s question${job}: ${f.need ?? ''} Let me know here and I'll draft the reply.`
    case 'reminder': return `Still hoping someone can help with this one${job} — ${f.need ?? ''}`
    case 'timed_out': return `No answer on this yet, so I've flagged it to the team by email so the partner isn't left hanging.`
    case 'noted_rules': return `Got it — I'll remember ${f.rules?.length === 1 ? 'this' : 'these'}:\n${(f.rules ?? []).map(r => `• ${r}`).join('\n')}`
    case 'draft_ready': return `Thanks ${f.who ?? ''} — here's what I'd send back.`
    case 'left_to_person': return `Understood, I'll leave this one to a person. It's in the review queue.`
  }
}

/** Write one chat message in Cassie's voice. Never throws. */
export async function chatVoice(settings: AgentSettings, f: VoiceFacts): Promise<string> {
  const plain = fallback(f)
  if (!isLlmConfigured()) return plain
  const brief: Record<ChatPurpose, string> = {
    ask: 'You are asking the team for help answering a partner email. Say what the partner asked, what you found and what you are missing, and that you will write back to them once you know. Ask them to reply here and mention @Cassie.',
    reviewer_ask: 'A reviewer looked at your draft and wants the team to weigh in. Bring the team into it in your own words: what the partner asked, what the draft says, and the specific question. Mention who sent you here by first name, naturally.',
    reminder: 'A gentle nudge: nobody has answered yet. One line.',
    timed_out: 'Nobody answered in time; you have emailed the team about it so the partner is not left waiting. One line.',
    noted_rules: 'A coworker just told you a rule for the future. Say you have got it and will keep it, and list the rule(s) briefly so they can correct you.',
    draft_ready: 'Someone answered your question; you have written the partner reply from it and it appears right under this line. One short line thanking them by first name and saying to hit Approve if it reads right.',
    left_to_person: 'The team said to leave this to a person. Acknowledge in one line; it is now in the review queue.',
  }
  const facts = [
    `PURPOSE: ${brief[f.purpose]}`,
    f.partner ? `PARTNER: ${f.partner}` : null, f.partnerAsked ? `PARTNER ASKED: ${f.partnerAsked}` : null,
    f.jobNumber ? `JOB: ${f.jobNumber}` : 'JOB: none matched', f.need ? `WHAT I NEED / MY QUESTION: ${f.need}` : null,
    f.reviewer ? `SENT BY: ${f.reviewer}` : null, f.who ? `WHO ANSWERED: ${f.who}` : null,
    f.rules?.length ? `RULES:\n${f.rules.map(r => `- ${r}`).join('\n')}` : null, f.extra ? `ALSO: ${f.extra}` : null,
  ].filter(Boolean).join('\n')
  try {
    const model = settings.classifier_model
    const res = await llm().messages.create({
      model, max_tokens: 400, system: VOICE, messages: [{ role: 'user', content: facts }],
      ...(isAdaptiveThinkingModel(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } } : {}),
    })
    const text = res.content.filter((b): b is { type: 'text'; text: string } & typeof b => b.type === 'text').map(b => b.text).join('\n').trim()
    return text || plain
  } catch { return plain }
}
