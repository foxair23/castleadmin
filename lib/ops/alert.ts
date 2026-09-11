import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'

// Automation/crawler alerts from the browser extension → email the chosen
// recipients. Covers any source ('service_fusion', 'genie', future portals) and
// any kind ('logged_out', 'error'). Deduped per (source, kind) so a persistent
// problem re-detected each run emails at most once per COOLDOWN window.

const COOLDOWN_HOURS = 6
const NOTIFICATION_KEY = 'automation_alert'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

// Known sources get a friendly label; unknown (future) sources use their raw key.
const SOURCE_LABELS: Record<string, string> = {
  service_fusion: 'Service Fusion',
  genie: 'Genie / Home Depot portal',
  clopay: 'Clopay HD Program portal',
  castle_admin: 'Castle Admin',
}
const REASON_TEXT: Record<string, string> = {
  'bad-credentials': 'the site rejected the saved username or password',
  'mfa-or-captcha': 'the site asked for a verification code or captcha, which cannot be automated',
  'oidc-callback-error': 'the sign-in handoff (OIDC) returned an error',
  'submit-did-not-navigate': 'the login form was filled and submitted but the page did not move on',
  'already-tried-this-tab': 'the site bounced straight back to the login page after signing in',
  'no-creds': 'no saved credentials for this site in the extension Options',
}
const label = (source: string) => SOURCE_LABELS[source] || source

async function alertedRecently(supabase: SupabaseClient, dedupKey: string): Promise<boolean> {
  const since = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString()
  const { data } = await supabase
    .from('notification_log')
    .select('id, notification_types!inner(key)')
    .eq('related_entity_type', 'automation')
    .eq('related_entity_id', dedupKey)
    .eq('notification_types.key', NOTIFICATION_KEY)
    .gte('created_at', since)
    .limit(1)
  return !!(data && data.length)
}

export interface AlertInput { source: string; kind?: 'logged_out' | 'error'; detail?: string }
export interface AlertResult { ok: boolean; sent: number; skipped?: string; error?: string }

/** Enqueue an automation alert email to subscribers (deduped). Never throws. */
export async function sendAutomationAlert(input: AlertInput): Promise<AlertResult> {
  const { source, kind = 'error', detail } = input
  if (!source) return { ok: false, sent: 0, error: 'source required' }
  try {
    const supabase = db()
    const dedupKey = `${source}:${kind}`
    if (await alertedRecently(supabase, dedupKey)) return { ok: true, sent: 0, skipped: 'cooldown' }

    const site = label(source)
    const loggedOut = kind === 'logged_out'
    // The extension only reports logged_out AFTER its own unattended login was tried
    // (twice, in a fresh tab the second time) and did not take — so say that, and why.
    const reasonKey = (detail ?? '').match(/[a-z]+(?:-[a-z]+)+/)?.[0] ?? ''
    const why = REASON_TEXT[reasonKey] ?? (detail ? detail : 'the site did not accept the automatic sign-in')
    const subject = loggedOut ? `⚠️ Auto-login to ${site} failed — automation paused` : `⚠️ ${site} automation error`
    const lead = loggedOut
      ? `The Castle browser extension tried to sign in to ${site} with the saved credentials and it did not work: ${why}. Crawls and posts that depend on ${site} are paused until a sign-in succeeds.`
      : `The Castle browser extension hit an error with ${site}.${detail ? ` Details: ${detail}` : ''}`
    const action = loggedOut
      ? (reasonKey === 'bad-credentials' || reasonKey === 'no-creds'
        ? 'Check the saved username and password for this site in the extension Options on the office machine. The next hourly warm-up retries automatically.'
        : 'Nothing to do yet: the extension retries the sign-in every hour on its own. If this repeats for more than a day, check the site by hand.')
      : 'Check the extension on the office PC (popup / service-worker console). It retries automatically on the next run.'
    const bodyText = `${lead}\n\nWhat to do: ${action}`
    const bodyHtml = `<p>${lead}</p><p><strong>What to do:</strong> ${action}</p>`

    const sent = await enqueueForSubscribers({
      notificationTypeKey: NOTIFICATION_KEY,
      subject,
      bodyHtml,
      bodyText,
      relatedEntityType: 'automation',
      relatedEntityId: dedupKey,
      payload: { source, kind, detail: detail ?? null },
    })
    return { ok: true, sent }
  } catch (e) {
    return { ok: false, sent: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
