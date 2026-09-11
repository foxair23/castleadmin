import type { SupabaseClient } from '@supabase/supabase-js'
import type Anthropic from '@anthropic-ai/sdk'
import { llm, isLlmConfigured, isAdaptiveThinkingModel, describeLlmError } from '@/lib/agent/llm'
import type { AgentSettings } from '@/lib/agent/settings'
import { getActiveCharter, listInstructions, listAnswers } from '@/lib/agent/knowledge'
import { resolveJob } from '@/lib/agent/job-resolver'
import { refreshJob } from '@/lib/agent/live-refresh'
import { factsFromLive } from '@/lib/agent/email/grounding'
import { postText } from './google-chat'
import type { ChatEvent } from '@/lib/agent/email/chat-assist'

// Cassie as a colleague. A team member messages her in Google Chat — a DM, or an @mention
// that is not in one of her ask threads — and she answers the way a person on the team
// would: looks the job up when it is a work question, says what she sees and what she
// does not, and just talks when it is not work. She reads only; nothing here changes a
// job, sends a partner anything, or posts outside the thread she was spoken to in.
// Every exchange is written to agent_chat_events, which is also her memory of the thread.

const MAX_TOOL_ROUNDS = 4
const HISTORY_TURNS = 14

// ── Tools ──────────────────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_job',
    description: 'Find a Service Fusion job. Give whatever the person mentioned: a job number, a PO / Home Depot order number, a customer name, phone or email. Returns the match (or the candidates when more than one job could fit) with live status, schedule, tech and customer.',
    input_schema: { type: 'object', properties: {
      job_number: { type: 'string', description: 'SF job number, e.g. 1020259280' },
      po: { type: 'string', description: 'PO / order number as written' },
      customer_name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
    }, additionalProperties: false },
  },
  {
    name: 'job_details',
    description: 'Live details for one job by its SF job id (from find_job): status, schedule, arrival window, completion, techs, customer, POs.',
    input_schema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
  },
  {
    name: 'find_order',
    description: 'Look up a Home Depot / Clopay / Genie vendor order by its order number or PO: portal status, customer, address, linked SF job, install/appointment date.',
    input_schema: { type: 'object', properties: { number: { type: 'string', description: 'order number, PO, or ticket number' } }, required: ['number'], additionalProperties: false },
  },
  {
    name: 'search_answers',
    description: 'Search the team answer library (how-we-do-things answers written by the office).',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
]

const s = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const num = (v: unknown): string | null => { const d = s(v)?.replace(/\D/g, ''); return d && d.length >= 6 ? d : null }

async function liveSummary(jobId: string, label: string): Promise<string> {
  const r = await refreshJob(jobId)
  if (r.status !== 'fresh') return `${label}: could not read it live right now (${r.error}).`
  return factsFromLive(r.facts, label).map(f => f.text).join(' ')
}

async function runTool(db: SupabaseClient, settings: AgentSettings, name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'find_job') {
    const jobNumber = num(input.job_number)
    if (jobNumber) {
      const { data: j } = await db.from('sf_jobs').select('id, number, customer_name, status').eq('number', jobNumber).eq('is_deleted', false).maybeSingle()
      if (!j) return `No job #${jobNumber} in Service Fusion.`
      return `Job ${j.number} (id ${j.id}), customer ${j.customer_name ?? '?'}. ${await liveSummary(String(j.id), `Job ${j.number}`)}`
    }
    const ids = { pos: s(input.po) ? [s(input.po)!] : undefined, customerName: s(input.customer_name), email: s(input.email), phone: s(input.phone) }
    if (!ids.pos && !ids.customerName && !ids.email && !ids.phone) return 'Give me a job number, PO, customer name, phone or email to look up.'
    const r = await resolveJob(db, ids, { windowDays: settings.closed_window_days })
    if (r.status === 'matched') return `Matched by ${r.tier}: Job ${r.job.number} (id ${r.job.id}), customer ${r.job.customer_name ?? '?'}. ${await liveSummary(String(r.job.id), `Job ${r.job.number}`)}`
    if (r.status === 'ambiguous') return `More than one job could match (by ${r.tier}): ${r.candidates.slice(0, 6).map(c => `Job ${c.number} (id ${c.id}) — ${c.customer_name ?? '?'} — ${c.status ?? '?'}${c.start_date ? ` — ${c.start_date}` : ''}`).join('; ')}. Ask which one, or use job_details on the right id.`
    return `No active job found (tried ${r.tried.join(', ')}).${r.outOfScope.length ? ` Older, closed jobs that match: ${r.outOfScope.slice(0, 3).map(c => `Job ${c.number} — ${c.customer_name ?? '?'} — closed ${c.closed_at ?? '?'}`).join('; ')}.` : ''}`
  }
  if (name === 'job_details') {
    const id = s(input.job_id)
    if (!id) return 'job_id required'
    return await liveSummary(id, `Job ${id}`)
  }
  if (name === 'find_order') {
    const n = s(input.number, 40)
    if (!n) return 'number required'
    const digits = n.replace(/\D/g, '')
    const { data } = await db.from('vendor_orders').select('vendor, external_id, customer_po, customer_name, status, next_step, street_address, city, order_date, appointment_date, appointment_window_start, appointment_window_end, sf_job_id, sf_created_job_number')
      .or(`external_id.eq.${digits || n},customer_po.eq.${n}${digits ? `,customer_po.eq.${digits}` : ''}`).limit(5)
    if (!data?.length) return `No vendor order found for ${n}.`
    return data.map(o => `${o.vendor === 'clopay_hd' ? 'Clopay' : o.vendor === 'genie_thd' ? 'Genie' : o.vendor} order ${o.external_id}${o.customer_po ? ` (PO ${o.customer_po})` : ''}: ${o.customer_name ?? '?'}, ${[o.street_address, o.city].filter(Boolean).join(', ')}. Portal status "${o.status ?? '?'}"${o.next_step ? `, next step "${o.next_step}"` : ''}. Ordered ${o.order_date ?? '?'}.${o.appointment_date ? ` Appointment ${o.appointment_date}${o.appointment_window_start ? ` ${o.appointment_window_start}–${o.appointment_window_end}` : ''}.` : ''}${o.sf_job_id ? ` Linked SF job id ${o.sf_job_id}${o.sf_created_job_number ? ` (#${o.sf_created_job_number})` : ''}.` : ' No SF job linked.'}`).join('\n')
  }
  if (name === 'search_answers') {
    const q = (s(input.query, 120) ?? '').toLowerCase()
    const all = await listAnswers(db)
    const hits = all.filter(a => `${a.title} ${a.question_examples.join(' ')} ${a.answer_text}`.toLowerCase().includes(q)).slice(0, 3)
    return hits.length ? hits.map(h => `${h.title}: ${h.answer_text}`).join('\n\n') : 'Nothing in the answer library for that.'
  }
  return `unknown tool ${name}`
}

// ── Conversation ────────────────────────────────────────────────────────────
function systemPrompt(charter: string, instructions: string[], now: Date): string {
  const when = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `You are Cassie, a member of the Castle Garage Doors & Gates team, chatting with your coworkers in Google Chat. It is ${when} Pacific.

How to be here:
- Talk like a colleague: warm, direct, brief. Humor is fine. Not everything is work — if someone just wants to chat, chat.
- When it is about a job, order, customer or schedule, LOOK IT UP with the tools before answering, and say what you found and what you did not. Never state a date, status, name or number you did not get from a tool or from the person. If a lookup fails or is ambiguous, say so and ask.
- You read our systems; you cannot change a job, book anything, or contact a customer or partner from here. If someone asks you to, say what you can do instead (e.g. who to ask, or that they can do it in Service Fusion).
- Internal status words ("waiting for Tiffany" and the like) are fine to repeat to coworkers — you are talking to the team, not a partner.
- If asked, you are an AI teammate; do not pretend otherwise, and do not bring it up unprompted.
- One message per reply, no headers, no bullet walls. Match the other person's length.

STANDING INSTRUCTIONS from the team (apply all):
${instructions.length ? instructions.map(i => `- ${i}`).join('\n') : '- (none yet)'}

For background, your charter (the partner-email rules in it apply to partner email, not to this chat):
${charter.slice(0, 12000)}`
}

export interface ColleagueOutcome { replied: boolean; text?: string; toolsUsed: string[]; reason?: string }

/** Answer a team member's message in its thread. */
export async function answerColleague(db: SupabaseClient, settings: AgentSettings, ev: ChatEvent): Promise<ColleagueOutcome> {
  if (!settings.chat_colleague_enabled) return { replied: false, toolsUsed: [], reason: 'colleague mode off' }
  const space = ev.space?.name ?? ev.message?.space?.name
  if (!space) return { replied: false, toolsUsed: [], reason: 'no space' }
  const threadName = ev.message?.thread?.name ?? null
  const who = ev.user?.displayName ?? ev.message?.sender?.displayName ?? 'someone'
  const text = (ev.message?.argumentText ?? ev.message?.text ?? '').replace(/@\S*cassie\S*/gi, '').trim()
  if (!text) return { replied: false, toolsUsed: [], reason: 'empty' }
  if (!isLlmConfigured()) {
    await postText(space, null, `Hi ${who.split(' ')[0]} — I can hear you, but my model key is not set up yet, so I cannot answer properly. Someone will need to add ANTHROPIC_API_KEY.`, threadName)
    return { replied: true, toolsUsed: [], reason: 'no llm' }
  }

  // Memory: what was said in this thread before, both directions.
  const history: Anthropic.MessageParam[] = []
  if (threadName) {
    const { data } = await db.from('agent_chat_events').select('event_type, sender_name, body, received_at').eq('thread_name', threadName).in('event_type', ['MESSAGE', 'CASSIE_REPLY']).order('received_at', { ascending: false }).limit(HISTORY_TURNS)
    for (const r of (data ?? []).reverse()) {
      const body = (r.body as string | null)?.trim()
      if (!body || body === text) continue
      history.push(r.event_type === 'CASSIE_REPLY' ? { role: 'assistant', content: body } : { role: 'user', content: `${r.sender_name ?? 'someone'}: ${body}` })
    }
  }
  // Consecutive same-role turns must be merged for the API.
  const merged: Anthropic.MessageParam[] = []
  for (const m of [...history, { role: 'user' as const, content: `${who}: ${text}` }]) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') last.content = `${last.content}\n${m.content}`
    else merged.push({ ...m })
  }
  if (merged[0]?.role !== 'user') merged.shift()

  const [charter, instructions] = await Promise.all([getActiveCharter(db), listInstructions(db)])
  const system = systemPrompt(charter.body, instructions.filter(i => i.channel === 'all' || i.channel === 'chat').map(i => i.text), new Date())
  const model = settings.composer_model
  const messages: Anthropic.MessageParam[] = merged
  const toolsUsed: string[] = []
  let reply = ''
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await llm().messages.create({
        model, max_tokens: 1024, system, tools: TOOLS, messages,
        ...(isAdaptiveThinkingModel(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } } : {}),
      })
      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      const textOut = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim()
      if (!toolUses.length || round === MAX_TOOL_ROUNDS) { reply = textOut; break }
      messages.push({ role: 'assistant', content: res.content })
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const tu of toolUses) {
        toolsUsed.push(tu.name)
        let out: string
        try { out = await runTool(db, settings, tu.name, (tu.input ?? {}) as Record<string, unknown>) } catch (e) { out = `lookup failed: ${e instanceof Error ? e.message : String(e)}` }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out })
      }
      messages.push({ role: 'user', content: results })
    }
  } catch (e) {
    reply = `Sorry ${who.split(' ')[0]}, I hit a snag answering that (${describeLlmError(e)}). Try me again in a minute.`
  }
  if (!reply) reply = "I looked but I do not have a good answer to that one. Can you give me a job number or PO?"
  const posted = await postText(space, null, reply, threadName)
  // Her side of the conversation, so the thread has memory next time.
  await db.from('agent_chat_events').insert({ event_type: 'CASSIE_REPLY', envelope: ev.addon ? 'addon' : 'classic', space_name: space, thread_name: threadName ?? posted.thread?.name ?? null, sender_name: 'Cassie', body: reply, outcome: toolsUsed.length ? `tools: ${toolsUsed.join(', ')}` : 'chat' }).then(() => {}, () => {})
  return { replied: true, text: reply, toolsUsed }
}
