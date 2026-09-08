import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAgentSettings, type AgentSettings } from '@/lib/agent/settings'
import { enqueueForSubscribers, hasRecentNotification } from '@/lib/notifications/enqueue'
import { appUrl } from '@/lib/config/domains'
import { loadGmailCredential, getAccessToken, fetchNewMessages, GmailAuthError } from './gmail'
import { ingestEmail } from './pipeline'
import { makeComposerStage } from './composer-stage'
import { sendQueuedReplies, type SendReport } from './sender'
import { runChatTimeouts } from './chat-assist'
import { recordPartnerReply, runConfusionCheck } from './outcomes'

// The one-minute poll (PRD §5). Fetch new mail → run the pipeline → send what is
// queued → record credential health. Every failure mode leaves a trace: a Gmail auth
// failure stops processing AND alerts the admins (once per day), because a silently
// expired token is the documented way these agents die (PRD §4 Authentication).

export interface PollReport {
  ran: boolean
  reason?: string
  fetched: number
  mode?: 'history' | 'search'
  outcomes: Record<string, number>
  send: SendReport | null
  chat?: { reminded: number; escalated: number }
  confusion?: { paused: string[] }
  error?: string
}

export async function runPoll(db: SupabaseClient, opts: { settings?: AgentSettings; max?: number } = {}): Promise<PollReport> {
  const settings = opts.settings ?? await loadAgentSettings(db)
  const report: PollReport = { ran: false, fetched: 0, outcomes: {}, send: null }
  if (!settings.processing_enabled) return { ...report, reason: 'processing_off' }

  const cred = await loadGmailCredential(db)
  if (!cred) return { ...report, reason: 'no_mailbox_credential' }

  try {
    const token = await getAccessToken(cred)
    const fetched = await fetchNewMessages(token, settings.gmail_history_id, { max: opts.max ?? 25 })
    report.ran = true
    report.fetched = fetched.emails.length
    report.mode = fetched.mode

    const composer = makeComposerStage()
    for (const email of fetched.emails) {
      const res = await ingestEmail(db, email, { settings, composer, partnerReply: recordPartnerReply })
      const k = res.duplicate ? 'duplicate' : res.outcome
      report.outcomes[k] = (report.outcomes[k] ?? 0) + 1
    }
    // Advance the cursor only after the batch is stored, so a crash mid-batch re-reads it.
    await db.from('agent_settings').update({ gmail_history_id: fetched.historyId, gmail_last_ok_at: new Date().toISOString(), gmail_last_error: null }).eq('id', 1)
    if (cred.source === 'db') await db.from('agent_gmail_credentials').update({ last_used_at: new Date().toISOString() }).eq('id', 1)

    report.send = await sendQueuedReplies(db, settings, cred)
    try { report.chat = await runChatTimeouts(db, settings) } catch (e) { console.error('[cassie] chat timeouts:', e instanceof Error ? e.message : e) }
    if (report.outcomes.partner_reply) { try { const c = await runConfusionCheck(db, settings); report.confusion = { paused: c.paused } } catch (e) { console.error('[cassie] confusion check:', e instanceof Error ? e.message : e) } }
    return report
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await db.from('agent_settings').update({ gmail_last_error: err.slice(0, 500), gmail_last_error_at: new Date().toISOString() }).eq('id', 1)
    if (e instanceof GmailAuthError) await alertCredentialFailure(err)
    return { ...report, error: err }
  }
}

async function alertCredentialFailure(err: string): Promise<void> {
  const recent = await hasRecentNotification({ notificationTypeKey: 'cassie_credential_failure', relatedEntityType: 'agent_settings', relatedEntityId: '1', withinHours: 24 })
  if (recent) return
  const url = `${appUrl()}/admin/cassie`
  const text = `Cassie's Gmail connection is failing and processing has stopped.\n\nError: ${err}\n\nReconnect the mailbox: ${url} → Settings → Mailbox → Connect Gmail (sign in as the Cassie account).`
  await enqueueForSubscribers({
    notificationTypeKey: 'cassie_credential_failure', subject: 'Cassie: mailbox connection failed — action needed',
    bodyHtml: `<p>Cassie's Gmail connection is failing and processing has stopped.</p><p><b>Error:</b> ${err.replace(/</g, '&lt;')}</p><p><a href="${url}">Reconnect the mailbox in Castle Admin → Cassie → Settings</a> (sign in as the Cassie account).</p>`,
    bodyText: text, relatedEntityType: 'agent_settings', relatedEntityId: '1',
  })
}
