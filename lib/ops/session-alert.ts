import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'

// Email alert when the browser extension finds a site logged out. Deduped so a
// still-logged-out state (re-detected every crawl/poll) sends at most one email
// per COOLDOWN window, not one per attempt.

const COOLDOWN_HOURS = 6
const NOTIFICATION_KEY = 'portal_session_logged_out'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const SITE_LABELS: Record<string, string> = {
  service_fusion: 'Service Fusion',
  genie: 'Genie / Home Depot portal',
}

/** True if we already alerted for this site within the cooldown window. */
async function alertedRecently(supabase: SupabaseClient, site: string): Promise<boolean> {
  const since = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString()
  const { data } = await supabase
    .from('notification_log')
    .select('id, notification_types!inner(key)')
    .eq('related_entity_type', 'portal_session')
    .eq('related_entity_id', site)
    .eq('notification_types.key', NOTIFICATION_KEY)
    .gte('created_at', since)
    .limit(1)
  return !!(data && data.length)
}

export interface SessionAlertResult { ok: boolean; sent: number; skipped?: string; error?: string }

/** Enqueue a "site logged out" email to subscribers (deduped). Never throws. */
export async function alertSessionLoggedOut(site: string): Promise<SessionAlertResult> {
  const label = SITE_LABELS[site]
  if (!label) return { ok: false, sent: 0, error: `unknown site '${site}'` }
  try {
    const supabase = db()
    if (await alertedRecently(supabase, site)) return { ok: true, sent: 0, skipped: 'cooldown' }

    const subject = `⚠️ ${label} is logged out — automation paused`
    const line = `The Castle browser extension found ${label} logged out on the office PC. Automation that depends on it (Service Fusion posting / notes, Genie order crawling) is paused until someone signs back in there.`
    const bodyText = `${line}\n\nWhat to do: on the office PC, open the site in Chrome and sign in (the saved password should fill in). Automation resumes automatically on the next run.`
    const bodyHtml = `<p>${line}</p><p><strong>What to do:</strong> on the office PC, open the site in Chrome and sign in (the saved password should fill in). Automation resumes automatically on the next run.</p>`

    const sent = await enqueueForSubscribers({
      notificationTypeKey: NOTIFICATION_KEY,
      subject,
      bodyHtml,
      bodyText,
      relatedEntityType: 'portal_session',
      relatedEntityId: site,
      payload: { site },
    })
    return { ok: true, sent }
  } catch (e) {
    return { ok: false, sent: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
