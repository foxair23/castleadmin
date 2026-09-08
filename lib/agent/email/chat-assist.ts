import type { SupabaseClient } from '@supabase/supabase-js'
import { appUrl } from '@/lib/config/domains'
import type { AgentSettings } from '@/lib/agent/settings'
import { buildCard, postCard, postText, updateCard, isChatConfigured } from '@/lib/agent/chat/google-chat'
import type { InboundEmail } from './types'

// Human assist via Google Chat (PRD §11). When Cassie cannot ground an answer she asks
// the team in a dedicated space, a person replies in the thread, and she composes a
// clean partner reply FROM that answer and posts it back with Approve / Edit / Send to
// review buttons. The person's words never reach the partner verbatim. A Chat answer
// authorises one reply, with explicit approval — it never opens an auto-send path.

const companyFor = (domain: string): string =>
  /homedepot/.test(domain) ? 'Home Depot' : /clopay/.test(domain) ? 'Clopay' : /genie/.test(domain) ? 'Genie' : domain

const reviewUrl = (replyId: string) => `${appUrl()}/admin/cassie?reply=${replyId}`
const sfJobUrl = (id: string) => `https://admin.servicefusion.com/jobs/jobEdit?id=${encodeURIComponent(id)}`

export interface AskInput {
  replyId: string
  messageId: string
  email: InboundEmail
  questionSummary: string
  missing: string
  sfJobNumber: string | null
  sfJobId: string | null
}

/** Post a specific, actionable ask. Deduplicates and rate-limits (PRD §11 noise control). */
export async function postChatAsk(db: SupabaseClient, settings: AgentSettings, a: AskInput): Promise<{ posted: boolean; reason?: string; askId?: string }> {
  if (!settings.chat_space_name) return { posted: false, reason: 'no_space' }
  if (!isChatConfigured()) return { posted: false, reason: 'chat_not_configured' }
  const domain = a.email.from.addr.split('@')[1] ?? ''
  const dedupeKey = a.email.gmailThreadId ? `thread:${a.email.gmailThreadId}` : `q:${a.missing.toLowerCase().replace(/\W+/g, ' ').trim().slice(0, 120)}`

  // Dedup: one open ask per thread / same missing thing within 24h.
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data: dup } = await db.from('agent_chat_asks').select('id').eq('dedupe_key', dedupeKey).gte('posted_at', since).in('status', ['open', 'answered', 'composed']).limit(1)
  if (dup?.length) return { posted: false, reason: 'duplicate_open_ask' }
  // Rate cap: never more than N asks per hour.
  const hourAgo = new Date(Date.now() - 3600_000).toISOString()
  const { count } = await db.from('agent_chat_asks').select('id', { count: 'exact', head: true }).gte('posted_at', hourAgo)
  if ((count ?? 0) >= settings.chat_max_asks_per_hour) return { posted: false, reason: 'rate_capped' }

  const { data: ask, error } = await db.from('agent_chat_asks').insert({
    reply_id: a.replyId, message_id: a.messageId, space_name: settings.chat_space_name, thread_key: `cassie-${a.replyId}`, question: a.missing, dedupe_key: dedupeKey, status: 'open',
  }).select('id').single()
  if (error) throw new Error(error.message)
  const askId = ask.id as string

  const who = a.email.from.name ? `${a.email.from.name} (${companyFor(domain)})` : `${a.email.from.addr} (${companyFor(domain)})`
  const card = buildCard(`ask-${askId}`, {
    header: 'Cassie needs a hand',
    subheader: `${who} · "${a.email.subject}"`,
    paragraphs: [
      { label: 'They asked', text: a.questionSummary },
      { label: 'What I need', text: a.missing },
      ...(a.sfJobNumber ? [{ label: 'Job', text: `Job ${a.sfJobNumber}` }] : [{ label: 'Job', text: 'No job matched' }]),
      { text: 'Reply in this thread with the answer (mention @Cassie so I see it). I will write the partner reply and post it here for approval.' },
    ],
    buttons: [
      ...(a.sfJobId ? [{ text: 'Open job', fn: 'open', url: sfJobUrl(a.sfJobId) }] : []),
      { text: 'Open in Castle Admin', fn: 'open', url: reviewUrl(a.replyId) },
    ],
  })
  try {
    const posted = await postCard(settings.chat_space_name, `cassie-${a.replyId}`, card, `Cassie needs a hand — ${who}: ${a.missing}`)
    await db.from('agent_chat_asks').update({ chat_message_name: posted.name, chat_thread_name: posted.thread?.name ?? null }).eq('id', askId)
    return { posted: true, askId }
  } catch (e) {
    // The ask row is written before the post so the card can carry its id. If the post
    // then fails, leaving the row 'open' would make the dedup check above swallow every
    // retry — the feature would look permanently broken after one bad attempt. Close it.
    await db.from('agent_chat_asks').update({ status: 'cancelled', resolved_at: new Date().toISOString() }).eq('id', askId)
    throw e
  }
}

/** Plain-English version of why an ask did not go out, for the reviewer. */
export const ASK_SKIP_REASON: Record<string, string> = {
  no_space: 'no Chat space is set (Cassie → Settings → Google Chat assist)',
  chat_not_configured: 'GOOGLE_CHAT_SERVICE_ACCOUNT_JSON is not set in Vercel',
  duplicate_open_ask: 'an ask for this thread is already open in the space',
  rate_capped: 'the per-hour ask cap was reached',
}

// ── Inbound events ──────────────────────────────────────────────────────────

export interface ChatUser { name?: string; displayName?: string; email?: string; type?: string }
export interface ChatEvent {
  type: 'MESSAGE' | 'CARD_CLICKED' | 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE' | string
  space?: { name?: string }
  user?: ChatUser
  message?: { name?: string; text?: string; argumentText?: string; thread?: { name?: string; threadKey?: string }; sender?: ChatUser }
  common?: { invokedFunction?: string; parameters?: Record<string, string> }
  action?: { actionMethodName?: string; parameters?: Array<{ key: string; value: string }> }
}

/** Which ask is this Chat message a reply to?
 *
 *  Google echoes the thread's RESOURCE NAME on inbound events, not the thread_key we chose,
 *  so the name recorded when we posted the card is the only exact key we have. Matching on
 *  anything looser than that can attach one partner's answer to another partner's question,
 *  which is the worst thing this feature could do — so when nothing matches exactly we
 *  return null and stay quiet rather than guess. */
async function askForThread(db: SupabaseClient, ev: ChatEvent) {
  const threadName = ev.message?.thread?.name ?? null
  const threadKey = ev.message?.thread?.threadKey ?? null
  if (threadName) {
    const { data } = await db.from('agent_chat_asks').select('*').eq('chat_thread_name', threadName).order('posted_at', { ascending: false }).limit(1).maybeSingle()
    if (data) return data
  }
  if (threadKey) {
    const { data } = await db.from('agent_chat_asks').select('*').eq('thread_key', threadKey).order('posted_at', { ascending: false }).limit(1).maybeSingle()
    if (data) return data
  }
  return null
}

const responderOf = (u: ChatUser | undefined) => ({ name: u?.displayName ?? u?.email ?? 'a team member', email: u?.email ?? null, id: u?.name ?? null })

/** What to do with a message that lands in an ask's thread. Silence is the worst possible
 *  answer here: a person who writes to Cassie and gets nothing back cannot tell whether she
 *  is broken, ignoring them, or simply slow. So every outcome says something.
 *
 *  A late answer is still worth having — the timeout escalates the email to the team, it
 *  does not send anything to the partner — so 'timed_out' is answerable, not closed. */
export function planForAsk(status: string, awaitingEdit: boolean): { act: 'edit' | 'answer' } | { act: 'explain'; text: string } {
  if (awaitingEdit) return { act: 'edit' }
  if (['open', 'answered', 'timed_out'].includes(status)) return { act: 'answer' }
  const said: Record<string, string> = {
    composed: 'I have already written a reply for this one — it is on the card above, waiting for Approve, Edit or Send to review.',
    approved: 'This one is already approved and on its way, so I have not changed anything.',
    sent: 'This one has already gone to the partner, so I have not changed anything.',
    reviewed: 'This one is already in the review queue for a person to finish.',
  }
  return { act: 'explain', text: said[status] ?? `This question is already closed (${status}), so I have not changed anything.` }
}

/** A person wrote in an ask's thread: either the answer, or the edited text we asked for. */
export async function handleChatMessage(db: SupabaseClient, settings: AgentSettings, ev: ChatEvent): Promise<string> {
  if (ev.user?.type === 'BOT' || ev.message?.sender?.type === 'BOT') return 'ignored bot'
  const ask = await askForThread(db, ev)
  if (!ask) {
    // An @mention with no open question behind it. Say so, rather than looking broken.
    const space = ev.space?.name
    if (space) await postText(space, ev.message?.thread?.threadKey ?? null, "I do not have an open question in this thread. I will post here when I need a hand with a partner email.", ev.message?.thread?.name ?? null)
    return 'no ask for this thread'
  }
  const text = (ev.message?.argumentText ?? ev.message?.text ?? '').replace(/@\S*cassie\S*/gi, '').trim()
  if (!text) return 'empty'
  const who = responderOf(ev.user ?? ev.message?.sender)

  const plan = planForAsk(String(ask.status), Boolean(ask.awaiting_edit && ask.draft_reply_id))
  if (plan.act === 'explain') {
    await postText(ask.space_name, ask.thread_key, `Thanks ${who.name}. ${plan.text} You can still open it here: ${reviewUrl(ask.reply_id as string)}`, ask.chat_thread_name as string | null)
    return `ask is ${ask.status}`
  }

  if (plan.act === 'edit' && ask.awaiting_edit && ask.draft_reply_id) {
    // Edited text replaces the draft body; a person approved that exact wording.
    const { approveReply } = await import('./review')
    const { data: r } = await db.from('agent_email_replies').select('composed_text').eq('id', ask.draft_reply_id).single()
    const { renderEmail } = await import('./compose')
    const full = renderEmail(text, settings, greetingNameFrom(r?.composed_text as string | null))
    await approveReply(db, ask.draft_reply_id as string, { text: full, note: `Edited in Google Chat by ${who.name}`, userId: null as unknown as string })
    await db.from('agent_email_replies').update({ approval_path: 'chat_approved' }).eq('id', ask.draft_reply_id)
    await db.from('agent_chat_asks').update({ status: 'approved', awaiting_edit: false, resolved_at: new Date().toISOString() }).eq('id', ask.id)
    await postText(ask.space_name, ask.thread_key, `Got it — sending your edited version. Thanks, ${who.name}.`)
    return 'edited and approved'
  }

  await db.from('agent_chat_asks').update({ status: 'answered', responder_name: who.name, responder_email: who.email, responder_id: who.id, response_text: text, responded_at: new Date().toISOString() }).eq('id', ask.id)
  // Compose a clean partner reply FROM the answer — never forward it.
  const { recomposeReply } = await import('./composer-stage')
  const rc = await recomposeReply(db, settings, ask.reply_id as string, `answered in Google Chat by ${who.name}`, { chatAnswer: { askId: ask.id as string, text, responder: who.name }, noChatAsk: true })
  if (rc.outcome === 'error' || !rc.replyId) {
    await postText(ask.space_name, ask.thread_key, `Thanks ${who.name}. I could not write the reply (${rc.detail ?? 'unknown error'}). It is in the review queue: ${reviewUrl(ask.reply_id as string)}`)
    return 'compose failed'
  }
  const { data: draft } = await db.from('agent_email_replies').select('composed_text, unsourced_claims').eq('id', rc.replyId).single()
  const body = stripWrapper((draft?.composed_text as string) ?? '')
  const unsourced = (draft?.unsourced_claims as string[]) ?? []
  const card = buildCard(`draft-${rc.replyId}`, {
    header: 'Here is what I would send',
    subheader: `Based on ${who.name}'s answer`,
    paragraphs: [
      { label: 'Reply to the partner', text: body },
      ...(unsourced.length ? [{ label: 'Heads up — not backed by a record', text: unsourced.join('\n') }] : []),
    ],
    buttons: [
      { text: 'Approve & send', fn: 'approve', params: { ask: ask.id as string, reply: rc.replyId }, primary: true },
      { text: 'Edit', fn: 'edit', params: { ask: ask.id as string, reply: rc.replyId } },
      { text: 'Send to review', fn: 'review', params: { ask: ask.id as string, reply: rc.replyId } },
      { text: 'Save answer to library', fn: 'promote', params: { ask: ask.id as string } },
    ],
  })
  const posted = await postCard(ask.space_name, ask.thread_key, card, `Draft reply based on ${who.name}'s answer`)
  await db.from('agent_chat_asks').update({
    status: 'composed', draft_reply_id: rc.replyId, draft_card_name: posted.name,
    ...(ask.chat_thread_name ? {} : { chat_thread_name: posted.thread?.name ?? null }),
  }).eq('id', ask.id)
  return 'composed'
}

/** Button click. The HTTP route has already acknowledged within Google's 30-second limit; this does the work. */
export async function handleCardClick(db: SupabaseClient, settings: AgentSettings, ev: ChatEvent): Promise<string> {
  const fn = ev.common?.invokedFunction ?? ev.action?.actionMethodName ?? ''
  const params: Record<string, string> = ev.common?.parameters ?? Object.fromEntries((ev.action?.parameters ?? []).map(p => [p.key, p.value]))
  const who = responderOf(ev.user)
  const { data: ask } = params.ask ? await db.from('agent_chat_asks').select('*').eq('id', params.ask).single() : { data: null }
  if (!ask) return 'no ask'
  const replyId = params.reply ?? (ask.draft_reply_id as string | null)
  const done = (title: string) => buildCard(`done-${ask.id}`, { header: title, subheader: `${who.name} · ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`, paragraphs: [{ text: replyId ? `Castle Admin → Cassie → Review: ${reviewUrl(replyId)}` : '' }] })

  switch (fn) {
    case 'approve': {
      if (!replyId) return 'no reply'
      const { approveReply } = await import('./review')
      const { data: r } = await db.from('agent_email_replies').select('composed_text, status').eq('id', replyId).single()
      if (r?.status !== 'draft') { await postText(ask.space_name, ask.thread_key, `That draft is already ${r?.status}.`); return 'not draft' }
      await approveReply(db, replyId, { text: r.composed_text as string, note: `Approved in Google Chat by ${who.name}`, userId: null as unknown as string })
      await db.from('agent_email_replies').update({ approval_path: 'chat_approved' }).eq('id', replyId)
      await db.from('agent_chat_asks').update({ status: 'approved', resolved_at: new Date().toISOString() }).eq('id', ask.id)
      if (ask.draft_card_name) await updateCard(ask.draft_card_name, done('Approved — sending'), `Approved by ${who.name}`)
      return 'approved'
    }
    case 'edit': {
      await db.from('agent_chat_asks').update({ awaiting_edit: true }).eq('id', ask.id)
      await postText(ask.space_name, ask.thread_key, `Reply in this thread with the exact wording you want sent (mention @Cassie). I will send that instead.`)
      return 'awaiting edit'
    }
    case 'review': {
      await db.from('agent_chat_asks').update({ status: 'sent_to_review', resolved_at: new Date().toISOString() }).eq('id', ask.id)
      if (ask.draft_card_name) await updateCard(ask.draft_card_name, done('Sent to the review queue'), `Sent to review by ${who.name}`)
      return 'sent to review'
    }
    case 'promote': {
      if (!ask.response_text) return 'nothing to promote'
      const { data: entry } = await db.from('agent_answer_library').insert({
        title: (ask.question as string).slice(0, 120), question_examples: [ask.question], answer_text: ask.response_text, audience: 'partner', is_active: true, source_chat_ask_id: ask.id,
      }).select('id').single()
      await db.from('agent_chat_asks').update({ promoted_library_id: entry?.id ?? null }).eq('id', ask.id)
      await postText(ask.space_name, ask.thread_key, `Saved to the answer library. Next time this comes up I will answer it myself. You can tidy the wording under Castle Admin → Cassie → Answer Library.`)
      return 'promoted'
    }
    default:
      return `unknown function ${fn}`
  }
}

/** Runs from the poll: remind once after the timeout, escalate after twice the timeout. */
export async function runChatTimeouts(db: SupabaseClient, settings: AgentSettings): Promise<{ reminded: number; escalated: number }> {
  const out = { reminded: 0, escalated: 0 }
  if (!settings.chat_space_name || !isChatConfigured()) return out
  const t = settings.chat_timeout_minutes * 60_000
  const { data } = await db.from('agent_chat_asks').select('id, reply_id, space_name, thread_key, posted_at, reminded_at, question').eq('status', 'open').lte('posted_at', new Date(Date.now() - t).toISOString()).limit(20)
  for (const a of data ?? []) {
    const age = Date.now() - Date.parse(a.posted_at as string)
    try {
      if (!a.reminded_at) {
        await postText(a.space_name as string, a.thread_key as string, `Still waiting on this one — anyone able to answer? "${a.question}"`)
        await db.from('agent_chat_asks').update({ reminded_at: new Date().toISOString() }).eq('id', a.id); out.reminded++
      } else if (age >= 2 * t) {
        const { escalateReply } = await import('./review')
        try { await escalateReply(db, a.reply_id as string, { note: 'No answer in Google Chat within the timeout.', userId: null as unknown as string, userName: 'Cassie (timeout)', settings }) } catch { /* reply may already be closed */ }
        await db.from('agent_chat_asks').update({ status: 'timed_out', resolved_at: new Date().toISOString() }).eq('id', a.id)
        await postText(a.space_name as string, a.thread_key as string, `No answer in time — I have escalated this to the team by email so the partner is not left waiting.`)
        out.escalated++
      }
    } catch (e) { console.error('[cassie] chat timeout step failed:', e instanceof Error ? e.message : e) }
  }
  return out
}

// The Chat card shows only the body; greeting/signature are re-added on send by renderEmail().
function stripWrapper(full: string): string {
  const cut = full.indexOf('\n—\n')
  let t = cut >= 0 ? full.slice(0, cut) : full
  t = t.replace(/^\s*Hi[^\n]*,\s*\n+/i, '').replace(/\n+\s*Cassie\s*\n\s*Castle Garage Doors & Gates\s*$/i, '')
  return t.trim()
}
function greetingNameFrom(full: string | null): string | null {
  const m = /^\s*Hi ([^,\n]+),/.exec(full ?? '')
  return m ? m[1] : null
}
