import type { SupabaseClient } from '@supabase/supabase-js'
import type Anthropic from '@anthropic-ai/sdk'
import type { AgentSettings } from '@/lib/agent/settings'
import { isLlmConfigured } from '@/lib/agent/llm'
import { getActiveCharter, listInstructions } from '@/lib/agent/knowledge'
import { LOOKUP_TOOLS, runLookupTool, runCassieTurn, tidyHistory } from '@/lib/agent/chat/colleague'
import { saveLearnedInstructions, normalizeRule } from './teach'
import { stripQuotedHistory } from './filters'

// Talking to Cassie about ONE partner email, on the Review page. The reviewer and Cassie go
// back and forth like a chat; as they talk she can look things up, revise the draft, ask the
// team in Google Chat (a question she writes herself, from the conversation), or keep a rule
// for next time. The thread is stored by inbound message, so it survives superseded drafts.

export interface ChatTurn { id: string; role: 'user' | 'cassie'; text: string; user_name: string | null; meta: Record<string, unknown> | null; created_at: string }

const ACTION_TOOLS: Anthropic.Tool[] = [
  {
    name: 'revise_draft',
    description: 'Write the partner reply again with this guidance (what to change, facts to use). Use when the reviewer asks for a change or you have learned something that changes the reply. Returns the new draft text.',
    input_schema: { type: 'object', properties: { instruction: { type: 'string', description: 'What to do differently, in one or two sentences, with any facts to rely on.' } }, required: ['instruction'], additionalProperties: false },
  },
  {
    name: 'ask_team',
    description: 'Post ONE specific question to the Castle team in Google Chat, in your own words, when you need something a lookup cannot give (what an internal status means, whether a past date is real, what to tell the partner). Their answer comes back to you and you draft again.',
    input_schema: { type: 'object', properties: { question: { type: 'string', description: 'The question, as you would ask a coworker: specific, with the job number and what you need.' } }, required: ['question'], additionalProperties: false },
  },
  {
    name: 'remember_rule',
    description: 'Keep a rule for future emails as a standing instruction (only when the reviewer states something general — "always", "never", "anything marked X" — not a fact about this job).',
    input_schema: { type: 'object', properties: { rule: { type: 'string', description: 'One clear sentence addressed to yourself.' } }, required: ['rule'], additionalProperties: false },
  },
]

function system(charter: string, instructions: string[], ctx: { subject: string; from: string; partnerText: string; draft: string | null; job: string | null; summary: string | null; unsourced: string[]; status: string }): string {
  return `You are Cassie, Castle Garage Doors & Gates' AI agent, talking with a Castle reviewer on the review page about ONE partner email and your draft reply to it. Talk like a colleague: brief, direct, honest about what you know and do not.

Rules:
- Never state a date, status, name or number you did not get from the facts below, a lookup, or the reviewer.
- If the reviewer asks for a change to the reply, use revise_draft — do not just describe the change.
- If something in the draft needs the team (an internal status word, a date that has passed, anything you cannot ground), use ask_team with a question in your own words. Do not ask the team things you can look up yourself.
- If the reviewer states a general rule, use remember_rule, then confirm what you kept.
- One message per turn. Do not paste the whole draft into chat unless asked; say what changed.

THE PARTNER EMAIL — from ${ctx.from}, subject "${ctx.subject}":
${ctx.partnerText.slice(0, 2500)}

${ctx.summary ? `THE QUESTION AS I READ IT: ${ctx.summary}\n` : ''}JOB: ${ctx.job ?? 'none matched'}
DRAFT STATUS: ${ctx.status}
MY CURRENT DRAFT:
${ctx.draft ? ctx.draft.slice(0, 3000) : '(no draft yet)'}
${ctx.unsourced.length ? `\nUNSOURCED CLAIMS FLAGGED IN THE DRAFT:\n${ctx.unsourced.map(u => `- ${u}`).join('\n')}` : ''}

STANDING INSTRUCTIONS from the team (apply all):
${instructions.length ? instructions.map(i => `- ${i}`).join('\n') : '- (none yet)'}

Your charter, for background:
${charter.slice(0, 8000)}`
}

async function context(db: SupabaseClient, messageId: string) {
  const { data: m } = await db.from('agent_email_messages').select('id, from_addr, from_name, subject, body_text').eq('id', messageId).maybeSingle()
  if (!m) return null
  const { data: r } = await db.from('agent_email_replies').select('id, status, composed_text, question_summary, sf_job_number, sf_job_id, unsourced_claims, created_at').eq('message_id', messageId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return {
    message: m, reply: r,
    ctx: {
      subject: (m.subject as string) ?? '', from: m.from_name ? `${m.from_name} <${m.from_addr}>` : String(m.from_addr ?? ''),
      partnerText: stripQuotedHistory((m.body_text as string) ?? ''), draft: (r?.composed_text as string | null) ?? null,
      job: r?.sf_job_number ? `Job ${r.sf_job_number}` : null, summary: (r?.question_summary as string | null) ?? null,
      unsourced: (r?.unsourced_claims as string[]) ?? [], status: (r?.status as string) ?? 'none',
    },
  }
}

export async function loadReviewChat(db: SupabaseClient, messageId: string): Promise<ChatTurn[]> {
  const { data } = await db.from('agent_reply_chat').select('id, role, text, user_name, meta, created_at').eq('message_id', messageId).order('created_at', { ascending: true }).limit(60)
  return (data ?? []) as ChatTurn[]
}

async function say(db: SupabaseClient, messageId: string, role: 'user' | 'cassie', text: string, userName: string | null, meta: Record<string, unknown> | null = null): Promise<ChatTurn> {
  const { data, error } = await db.from('agent_reply_chat').insert({ message_id: messageId, role, text, user_name: userName, meta }).select('id, role, text, user_name, meta, created_at').single()
  if (error) throw new Error(error.message)
  return data as ChatTurn
}

/** One exchange: the reviewer's message, then Cassie's reply (with whatever she did). */
export async function chatWithCassie(db: SupabaseClient, settings: AgentSettings, messageId: string, userText: string, user: { id: string; name: string | null }, opts: { forceAskTeam?: boolean } = {}): Promise<{ turns: ChatTurn[]; error?: string }> {
  const c = await context(db, messageId)
  if (!c) return { turns: [], error: 'message not found' }
  if (!opts.forceAskTeam) await say(db, messageId, 'user', userText, user.name)
  if (!isLlmConfigured()) { await say(db, messageId, 'cassie', 'My model key is not set up (ANTHROPIC_API_KEY), so I cannot talk yet.', null); return { turns: await loadReviewChat(db, messageId) } }

  const prior = (await loadReviewChat(db, messageId)).slice(-24)
  const history: Anthropic.MessageParam[] = prior.map(t => t.role === 'cassie' ? { role: 'assistant', content: t.text } : { role: 'user', content: `${t.user_name ?? 'Reviewer'}: ${t.text}` })
  if (opts.forceAskTeam) history.push({ role: 'user', content: `${user.name ?? 'Reviewer'}: Please ask the team in chat for what you need to answer this well.` })
  const [charter, instructions] = await Promise.all([getActiveCharter(db), listInstructions(db)])
  const sys = system(charter.body, instructions.filter(i => i.channel === 'all' || i.channel === 'email').map(i => i.text), c.ctx)

  const meta: Record<string, unknown> = { toolsUsed: [] as string[] }
  const runTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
    if (name === 'revise_draft') {
      if (!c.reply || c.reply.status !== 'draft') return `There is no live draft to revise (status ${c.reply?.status ?? 'none'}).`
      const { recomposeReply } = await import('./composer-stage')
      const rc = await recomposeReply(db, settings, c.reply.id as string, `revised in review chat by ${user.name ?? 'a reviewer'}`, { chatAnswer: { text: String(input.instruction ?? ''), responder: user.name ?? 'Reviewer', channel: 'review' }, noChatAsk: true })
      if (rc.outcome === 'error' || !rc.replyId) return `Could not revise: ${rc.detail ?? 'unknown error'}`
      const { data: d } = await db.from('agent_email_replies').select('composed_text, unsourced_claims').eq('id', rc.replyId).single()
      meta.revisedReplyId = rc.replyId
      c.reply = { ...(c.reply as Record<string, unknown>), id: rc.replyId, status: 'draft', composed_text: d?.composed_text } as typeof c.reply
      return `New draft written (reply ${rc.replyId}):\n${(d?.composed_text as string) ?? ''}${(d?.unsourced_claims as string[])?.length ? `\nUnsourced: ${(d?.unsourced_claims as string[]).join('; ')}` : ''}`
    }
    if (name === 'ask_team') {
      const question = String(input.question ?? '').trim()
      if (!question) return 'question required'
      if (!c.reply) return 'No reply to attach the question to.'
      const { postChatAsk, ASK_SKIP_REASON } = await import('./chat-assist')
      const email = { source: 'gmail' as const, gmailMessageId: null, gmailThreadId: null, internetMessageId: null, inReplyTo: null, references: [], from: { addr: String(c.message.from_addr ?? ''), name: (c.message.from_name as string | null) ?? null }, to: [], cc: [], subject: c.ctx.subject, bodyText: c.ctx.partnerText, headers: {}, receivedAt: new Date().toISOString() }
      const { data: mm } = await db.from('agent_email_messages').select('gmail_thread_id').eq('id', messageId).maybeSingle()
      const r = await postChatAsk(db, settings, { replyId: c.reply.id as string, messageId, email: { ...email, gmailThreadId: (mm?.gmail_thread_id as string | null) ?? null }, questionSummary: c.ctx.summary ?? c.ctx.subject, missing: question, sfJobNumber: (c.reply.sf_job_number as string | null) ?? null, sfJobId: (c.reply.sf_job_id as string | null) ?? null, askedBy: user.name ?? 'A reviewer' })
      if (!r.posted) return `Could not ask in Chat: ${ASK_SKIP_REASON[r.reason ?? ''] ?? r.reason}`
      meta.askId = r.askId
      await db.from('agent_email_feedback').insert({ reply_id: c.reply.id, kind: 'note', note: `Cassie asked the team in Google Chat: ${question}`, user_id: user.id })
      return `Posted to the team in Google Chat: "${question}". Their answer will come back to you and you will draft again.`
    }
    if (name === 'remember_rule') {
      const rule = normalizeRule(String(input.rule ?? ''))
      if (!rule) return 'rule required'
      const added = await saveLearnedInstructions(db, [rule], `review:${messageId}`)
      meta.learned = [...((meta.learned as string[]) ?? []), ...added]
      return added.length ? `Kept as a standing instruction: ${added[0]}` : 'That rule is already in my standing instructions.'
    }
    return runLookupTool(db, settings, name, input)
  }

  const turn = await runCassieTurn({ model: settings.composer_model, system: sys, messages: tidyHistory(history), tools: [...LOOKUP_TOOLS, ...ACTION_TOOLS], runTool, forceTool: opts.forceAskTeam ? 'ask_team' : undefined })
  meta.toolsUsed = turn.toolsUsed
  const text = turn.error ? `I hit a snag (${turn.error}). Try again in a minute.` : (turn.text || (meta.askId ? 'Asked the team in Chat.' : meta.revisedReplyId ? 'Draft revised.' : 'Done.'))
  await say(db, messageId, 'cassie', text, null, meta)
  return { turns: await loadReviewChat(db, messageId) }
}
