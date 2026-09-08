import type { SupabaseClient } from '@supabase/supabase-js'
import { agentReplyTo, type AgentSettings, type QuestionType, type MatchTier } from '@/lib/agent/settings'
import { recomposeReply } from './composer-stage'
import { officeEmail } from '@/lib/config/domains'
import { refreshJob, changedFacts, isMaterialChange, type LiveJobFacts } from '@/lib/agent/live-refresh'
import { loadThreadState } from './pipeline'
import { sendMessage, type GmailCredential, getAccessToken } from './gmail'

// Stage 6–7 — send queued replies (PRD §5). Runs every poll. For each queued reply
// whose send_after has passed:
//   1. Thread check — if a Castle person has written in the thread since the inquiry,
//      cancel permanently as 'superseded'. Never send a second answer.
//   2. Fact re-verify — read the job again live; if anything the reply could depend on
//      changed, do NOT send: material change → back to review; otherwise recompose
//      later (marked for it). Stale-but-unchanged is fine.
//   3. Send via Gmail into the partner's thread, CC the office, Reply-To the office.
//   4. Record: status 'sent', ids, an outbound row in agent_email_messages so thread
//      state sees it, and the message outcome.
// Failures increment send_attempts and keep the row queued (up to 5), then fail.

export interface SendReport { sent: number; superseded: number; heldForReview: number; recomposed: number; failed: number; skipped: number; errors: string[] }

interface QueuedReply {
  id: string; message_id: string; gmail_thread_id: string | null; sf_job_id: string | null; live_facts: LiveJobFacts | null
  composed_subject: string | null; sent_text: string | null; composed_text: string | null; send_attempts: number; approval_path: string | null
  question_type: string | null; resolve_tier: string | null
}

export async function sendQueuedReplies(db: SupabaseClient, settings: AgentSettings, cred: GmailCredential, opts: { now?: Date; max?: number } = {}): Promise<SendReport> {
  const now = opts.now ?? new Date()
  const report: SendReport = { sent: 0, superseded: 0, heldForReview: 0, recomposed: 0, failed: 0, skipped: 0, errors: [] }
  const { data } = await db.from('agent_email_replies')
    .select('id, message_id, gmail_thread_id, sf_job_id, live_facts, composed_subject, sent_text, composed_text, send_attempts, approval_path, question_type, resolve_tier')
    .eq('status', 'queued').lte('send_after', now.toISOString()).order('send_after', { ascending: true }).limit(opts.max ?? 10)
  const rows = (data ?? []) as unknown as QueuedReply[]
  if (!rows.length) return report

  let token: string | null = null
  for (const r of rows) {
    try {
      // 0. Auto-sent replies re-check the switches at send time — the master switch or a
      //    tier pause may have flipped during the hold window.
      if (r.approval_path === 'auto') {
        const tier = r.resolve_tier as MatchTier | null
        const pausedKey = `${r.question_type}:${tier}`
        const block = !settings.auto_respond_enabled ? 'Auto-Respond was turned off during the hold window'
          : (tier && settings.paused_tiers[pausedKey]) ? 'this question type + match tier was paused during the hold window'
          : (!settings.auto_question_types.includes(r.question_type as QuestionType) || !tier || !settings.auto_match_tiers.includes(tier)) ? 'auto-send settings changed during the hold window' : null
        if (block) { await hold(db, r.id, `${block}. Returned for review.`, now); report.heldForReview++; continue }
      }
      // 1. Human in the thread?
      const thread = await loadThreadState(db, r.gmail_thread_id)
      if (thread.humanRepliedAfterInquiry) {
        await db.from('agent_email_replies').update({ status: 'superseded', cancel_reason: 'human_replied', updated_at: now.toISOString() }).eq('id', r.id)
        await db.from('agent_email_messages').update({ outcome: 'superseded', outcome_detail: 'a Castle team member replied before Cassie sent' }).eq('id', r.message_id)
        report.superseded++; continue
      }
      // 2. Facts still true?
      if (r.sf_job_id && r.live_facts) {
        const fresh = await refreshJob(r.sf_job_id, { force: true })
        if (fresh.status !== 'fresh') {
          await hold(db, r.id, `Service Fusion could not be re-read before sending (${fresh.error}). Approve again to retry.`, now)
          report.heldForReview++; continue
        }
        const changed = changedFacts(r.live_facts, fresh.facts)
        if (changed.length) {
          if (isMaterialChange(changed) || r.approval_path !== 'auto') {
            // Material change, or a human approved specific wording → a person decides.
            await hold(db, r.id, `Job changed between drafting and sending: ${changed.join(', ')}. Draft returned for review.`, now, fresh.facts)
            report.heldForReview++; continue
          }
          // Minor change on an auto reply → recompose against fresh facts; the new draft
          // routes itself and restarts the hold window (PRD §6.4).
          const rc = await recomposeReply(db, settings, r.id, `${changed.join(', ')} changed before sending`)
          report.recomposed++
          report.errors.push(...(rc.outcome === 'error' ? [`${r.id}: recompose ${rc.detail}`] : []))
          continue
        }
      }
      // 3. Send.
      const { data: msg } = await db.from('agent_email_messages').select('from_addr, from_name, subject, internet_message_id, references_ids, gmail_thread_id, delivery_path').eq('id', r.message_id).single()
      if (!msg?.from_addr) throw new Error('inbound message missing sender')
      if (msg.delivery_path === 'replay') {
        // A pasted test email is never a real conversation. Approving it exercises the
        // flow; it must not email the address someone typed into the replay form.
        await db.from('agent_email_replies').update({ status: 'cancelled', cancel_reason: 'replay_never_sends', updated_at: now.toISOString() }).eq('id', r.id)
        await db.from('agent_email_feedback').insert({ reply_id: r.id, kind: 'note', note: 'Replayed test email — approved, but replays are never sent.' })
        report.skipped++; continue
      }
      const text = (r.sent_text ?? r.composed_text ?? '').trim()
      if (!text) throw new Error('reply text is empty')
      token ??= await getAccessToken(cred)
      const office = officeEmail()
      const cc = settings.cc_office && office.toLowerCase() !== (msg.from_addr as string).toLowerCase() ? [office] : []
      const res = await sendMessage(token, {
        fromName: settings.from_display_name, fromAddr: settings.mailbox_address,
        to: msg.from_name ? `"${String(msg.from_name).replace(/"/g, '')}" <${msg.from_addr}>` : String(msg.from_addr),
        cc, replyTo: agentReplyTo(settings),
        subject: r.composed_subject ?? (msg.subject ? `Re: ${msg.subject}` : 'Re: your inquiry'),
        text,
        inReplyTo: (msg.internet_message_id as string | null) ?? null,
        references: [...((msg.references_ids as string[]) ?? []), ...(msg.internet_message_id ? [msg.internet_message_id as string] : [])],
        gmailThreadId: (msg.gmail_thread_id as string | null) ?? r.gmail_thread_id,
      })
      // 4. Record.
      const sentAt = new Date().toISOString()
      await db.from('agent_email_replies').update({ status: 'sent', sent_at: sentAt, gmail_sent_message_id: res.id, gmail_sent_thread_id: res.threadId, last_send_error: null, updated_at: sentAt }).eq('id', r.id)
      await db.from('agent_email_messages').update({ outcome: 'sent', outcome_detail: `sent ${sentAt}${r.approval_path ? ` (${r.approval_path})` : ''}` }).eq('id', r.message_id)
      await db.from('agent_email_messages').insert({
        gmail_message_id: res.id, gmail_thread_id: res.threadId, direction: 'outbound_agent', delivery_path: 'direct',
        from_addr: settings.mailbox_address.toLowerCase(), from_name: settings.from_display_name, to_addrs: [String(msg.from_addr).toLowerCase()], cc_addrs: cc.map(c => c.toLowerCase()),
        subject: r.composed_subject, snippet: text.slice(0, 200), body_text: text, received_at: sentAt, outcome: 'sent', processed_at: sentAt,
      })
      report.sent++
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      report.errors.push(`${r.id}: ${err}`)
      const attempts = (r.send_attempts ?? 0) + 1
      const giveUp = attempts >= 5
      await db.from('agent_email_replies').update({ send_attempts: attempts, last_send_error: err.slice(0, 500), ...(giveUp ? { status: 'failed', error: `send failed ${attempts}×: ${err.slice(0, 300)}` } : {}), updated_at: new Date().toISOString() }).eq('id', r.id)
      if (giveUp) report.failed++; else report.skipped++
      if (e instanceof Error && e.name === 'GmailAuthError') break   // no point trying the rest this pass
    }
  }
  return report
}

async function hold(db: SupabaseClient, id: string, note: string, now: Date, freshFacts?: LiveJobFacts) {
  await db.from('agent_email_replies').update({
    status: 'draft', send_after: null, approval_path: null, approved_by: null, approved_at: null,
    cancel_reason: 'facts_changed', ...(freshFacts ? { live_facts: freshFacts, live_fetched_at: freshFacts.fetchedAt } : {}), updated_at: now.toISOString(),
  }).eq('id', id)
  await db.from('agent_email_feedback').insert({ reply_id: id, kind: 'note', note })
}
