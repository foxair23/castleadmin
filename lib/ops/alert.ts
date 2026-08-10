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
  castle_admin: 'Castle Admin',
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
    const subject = loggedOut ? `⚠️ ${site} is logged out — automation paused` : `⚠️ ${site} automation error`
    const lead = loggedOut
      ? `The Castle browser extension found ${site} logged out on the office PC. Automation that depends on it is paused until someone signs back in there.`
      : `The Castle browser extension hit an error with ${site}.${detail ? ` Details: ${detail}` : ''}`
    const action = loggedOut
      ? 'On the office PC, open the site in Chrome and sign in (the saved password should fill in). Automation resumes automatically on the next run.'
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
