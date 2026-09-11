import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join } from 'path'
import { enqueueForSubscribers, hasRecentNotification } from '@/lib/notifications/enqueue'
import { loadHealthSnapshot, evaluateHealth, decideTransitions, saveHealthStates, ptParts, type HealthReport } from './health'
import { renderHealthAlert, renderHealthDigest, type DigestCounts } from '@/lib/notifications/templates/automation-health'

// The two crons behind Automation Health. Evaluate: every 30 minutes in business hours
// plus once at 6am PT, email only the conditions that just turned red (or stayed red past
// the 6 h cooldown) and the ones that recovered. Digest: 7am PT, one summary of the state
// and yesterday's counts, whatever the colour.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}
export function extensionVersion(): string {
  try { return JSON.parse(readFileSync(join(process.cwd(), 'chrome-extension/sf-remittance/manifest.json'), 'utf8')).version as string } catch { return '?' }
}
const TYPE = 'automation_health'

export async function runHealthEvaluation(now = new Date()): Promise<{ overall: string; alerts: Array<{ condition: string; kind: string }>; queued: number }> {
  const supabase = db()
  const snapshot = await loadHealthSnapshot(supabase, extensionVersion(), now)
  const report = evaluateHealth(snapshot)
  const { alerts, states } = decideTransitions(snapshot.prevStates, report, now)
  let queued = 0
  // Belt and braces on top of the stored last_alerted_at: never the same condition twice in 6 h.
  const fresh: typeof alerts = []
  for (const a of alerts) {
    if (a.kind === 'red' && await hasRecentNotification({ notificationTypeKey: TYPE, relatedEntityType: 'automation_health', relatedEntityId: `${a.condition}:red`, withinHours: 6 })) continue
    fresh.push(a)
  }
  if (fresh.length) {
    const mail = renderHealthAlert(fresh, report)
    queued = await enqueueForSubscribers({ notificationTypeKey: TYPE, subject: mail.subject, bodyHtml: mail.bodyHtml, bodyText: mail.bodyText, relatedEntityType: 'automation_health', relatedEntityId: `${fresh[0].condition}:${fresh[0].kind}`, payload: { alerts: fresh } })
  }
  await saveHealthStates(states, report, supabase)
  return { overall: report.overall, alerts: fresh.map(a => ({ condition: a.condition, kind: a.kind })), queued }
}

/** Yesterday's counts (PT calendar day) from extension_runs. */
export async function yesterdayCounts(supabase: SupabaseClient, now: Date): Promise<{ counts: DigestCounts; dateLabel: string }> {
  const y = new Date(now.getTime() - 24 * 3_600_000)
  const yDate = ptParts(y).date
  const from = new Date(`${yDate}T00:00:00-07:00`); from.setHours(from.getHours() - 2)   // generous window; filtered by PT date below
  const { data } = await supabase.from('extension_runs').select('kind, site, mode, status, finished_at, counts').gte('created_at', from.toISOString()).limit(1000)
  const rows = (data ?? []).filter(r => r.finished_at && ptParts(new Date(r.finished_at as string)).date === yDate) as Array<{ kind: string; site: string | null; mode: string | null; status: string; counts: Record<string, unknown> | null }>
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  const counts: DigestCounts = { genie: { crawls: 0, done: 0, detailed: 0 }, clopay: { crawls: 0, done: 0, detailed: 0, docsStored: 0 }, sf: { runs: 0, failed: 0, applied: 0, notes: 0, lines: 0, appointments: 0, docs: 0 }, logins: { failed: 0 } }
  for (const r of rows) {
    if (r.kind === 'crawl' && r.status !== 'started' && (r.site === 'genie' || r.site === 'clopay')) {
      const c = counts[r.site]
      c.crawls++; if (r.status === 'done' || r.status === 'budget') c.done++
      c.detailed += n(r.counts?.detailed)
      if (r.site === 'clopay' && r.mode === 'docs') counts.clopay.docsStored += n(r.counts?.stored)
    } else if (r.kind === 'run') {
      counts.sf.runs++; if (r.status === 'failed') counts.sf.failed++
      const c = r.counts ?? {}
      counts.sf.applied += n(c.applied)
      counts.sf.notes += n((c.notes as Record<string, unknown> | undefined)?.posted)
      counts.sf.lines += n((c.lines as Record<string, unknown> | undefined)?.posted)
      counts.sf.appointments += n((c.schedule as Record<string, unknown> | undefined)?.posted)
      counts.sf.docs += n((c.docs as Record<string, unknown> | undefined)?.posted)
    } else if (r.kind === 'login' && r.status === 'failed') counts.logins.failed++
  }
  const dateLabel = new Date(`${yDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  return { counts, dateLabel }
}

export async function runHealthDigest(now = new Date()): Promise<{ overall: string; queued: number; pruned: number }> {
  const supabase = db()
  const snapshot = await loadHealthSnapshot(supabase, extensionVersion(), now)
  const report: HealthReport = evaluateHealth(snapshot)
  const { counts, dateLabel } = await yesterdayCounts(supabase, now)
  const mail = renderHealthDigest(report, counts, dateLabel)
  const queued = await enqueueForSubscribers({ notificationTypeKey: TYPE, subject: mail.subject, bodyHtml: mail.bodyHtml, bodyText: mail.bodyText, relatedEntityType: 'automation_health', relatedEntityId: `digest:${ptParts(now).date}` })
  // Keep 30 days of runs.
  const { count } = await supabase.from('extension_runs').delete({ count: 'exact' }).lt('created_at', new Date(now.getTime() - 30 * 24 * 3_600_000).toISOString())
  return { overall: report.overall, queued, pruned: count ?? 0 }
}
