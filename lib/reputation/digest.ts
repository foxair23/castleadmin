import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { enqueueForSubscribers, hasRecentNotification } from '@/lib/notifications/enqueue'
import { renderReputationDigest } from '@/lib/notifications/templates/reputation-digest'
import { loadInsights } from './insights'
import { loadReputationSettings } from './settings'
import { ptDateKey, ptWallToUtc, addPtDays } from './pt-time'

// Monday 7am PT: one email with last week's numbers next to the week before.
// Subscribers are the admins with the reputation_weekly_digest type on.

const TYPE = 'reputation_weekly_digest'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

/** Pure: the Monday–Sunday PT week that ended before `now`, plus the one before it. */
export function digestWeeks(now: Date): { thisWeek: { fromIso: string; toIso: string }; lastWeek: { fromIso: string; toIso: string }; weekLabel: string; key: string } {
  const today = ptDateKey(now)
  // Walk back to the most recent Monday strictly before today (a Monday run reports the week that just ended).
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay() // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1
  const thisMonday = addPtDays(today, -backToMonday)          // the Monday of the current week
  const weekStart = addPtDays(thisMonday, -7)                  // Monday of the week that ended
  const prevStart = addPtDays(weekStart, -7)
  const fmt = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return {
    thisWeek: { fromIso: ptWallToUtc(weekStart, 0).toISOString(), toIso: ptWallToUtc(thisMonday, 0).toISOString() },
    lastWeek: { fromIso: ptWallToUtc(prevStart, 0).toISOString(), toIso: ptWallToUtc(weekStart, 0).toISOString() },
    weekLabel: `Week of ${fmt(weekStart)}–${fmt(addPtDays(weekStart, 6))}`,
    key: weekStart,
  }
}

export async function runReputationDigest(now = new Date()): Promise<{ queued: number; skipped?: string; week: string }> {
  const supabase = db()
  const weeks = digestWeeks(now)
  if (await hasRecentNotification({ notificationTypeKey: TYPE, relatedEntityType: 'reputation_digest', relatedEntityId: weeks.key, withinHours: 24 * 6 })) {
    return { queued: 0, skipped: 'already sent for this week', week: weeks.key }
  }
  const settings = await loadReputationSettings(supabase)
  const [thisWeek, lastWeek] = await Promise.all([
    loadInsights(supabase, weeks.thisWeek, settings.photo_min_score),
    loadInsights(supabase, weeks.lastWeek, settings.photo_min_score),
  ])
  const mail = renderReputationDigest({ thisWeek, lastWeek, weekLabel: weeks.weekLabel })
  const queued = await enqueueForSubscribers({ notificationTypeKey: TYPE, subject: mail.subject, bodyHtml: mail.bodyHtml, bodyText: mail.bodyText, relatedEntityType: 'reputation_digest', relatedEntityId: weeks.key })
  return { queued, week: weeks.key }
}
