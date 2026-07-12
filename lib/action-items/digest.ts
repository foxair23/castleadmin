// Shared builder for the Action Items to-do emails (7 AM full list and 3 PM
// check-in). Classifies every item into:
//   🆕 needs first action — on a tab, no action recorded
//   🔔 follow-up due      — actioned, follow-up date reached, still unresolved
//   (waiting)             — actioned, inside the follow-up window — excluded
// Pressing an action button today moves the item out of both actionable
// buckets automatically (a press sets follow_up_on into the future), so the
// same computation at 3 PM shows exactly what is still left.

import { createClient as createAdminClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  getUnpaidJobs,
  getUninvoicedJobs,
  getStaleEstimates,
  getFollowUpJobs,
  getAwaitingSfJob,
  getOnlineSchedulingLeads,
  getAcceptedEstimatesAwaitingJob,
} from '@/lib/analytics/alerts'
import { ACTION_TAB_CONFIG, todayPT } from './config'

export interface Line { text: string; sub?: string }
export interface TabBucket { tab: string; label: string; newLines: Line[]; dueLines: Line[] }

export interface TodoDigest {
  buckets: TabBucket[]
  schedulingLines: Line[]
  totalNew: number
  totalDue: number
  /** Action-button presses whose actioned_at falls on today (PT). */
  actionedTodayByLabel: Map<string, number>
  actionedToday: number
}

const money = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

const ptDay = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso))

export function adminDb(): SupabaseClient {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export async function computeTodoDigest(db: SupabaseClient): Promise<TodoDigest> {
  const [unpaid, uninvoiced, stale, followUp, awaitingSf, onlineScheduling, accepted, { data: actionRows }, { data: acksToday }] =
    await Promise.all([
      getUnpaidJobs(),
      getUninvoicedJobs(),
      getStaleEstimates(),
      getFollowUpJobs(),
      getAwaitingSfJob(),
      getOnlineSchedulingLeads(),
      getAcceptedEstimatesAwaitingJob(),
      db.from('action_item_actions').select('entity_type, entity_id, action_label, actioned_at, follow_up_on'),
      db.from('scheduler_leads').select('id, acknowledged_at').not('acknowledged_at', 'is', null)
        .gte('acknowledged_at', new Date(Date.now() - 36 * 3_600_000).toISOString()),
    ])

  const today = todayPT()
  const actionByKey = new Map((actionRows ?? []).map(a => [`${a.entity_type}:${a.entity_id}`, a]))

  function bucketize<T extends { id: string }>(
    tab: string, label: string, items: T[], line: (item: T) => string,
  ): TabBucket {
    const cfg = ACTION_TAB_CONFIG[tab]
    const out: TabBucket = { tab, label, newLines: [], dueLines: [] }
    for (const item of items) {
      const rec = cfg ? actionByKey.get(`${cfg.entity}:${item.id}`) : undefined
      if (!rec) {
        out.newLines.push({ text: line(item) })
      } else if (rec.follow_up_on <= today) {
        out.dueLines.push({
          text: line(item),
          sub: `${rec.action_label} on ${rec.actioned_at.slice(0, 10)} — still unresolved`,
        })
      }
    }
    return out
  }

  const buckets: TabBucket[] = [
    bucketize('uninvoiced', 'Never Invoiced', uninvoiced.items,
      i => `${i.customer_name ?? '—'} — ${money(i.total)} — ${i.days_since_completion}d`),
    bucketize('unpaid', 'Unpaid Jobs', unpaid.items,
      i => `${i.customer_name ?? '—'} — ${money(i.due_total)} due — ${i.days_outstanding}d`),
    bucketize('accepted-no-job', 'Accepted, No Job', accepted.items,
      i => `${i.customer_name ?? '—'} — ${money(i.total)} — ${i.days_since_update}d`),
    bucketize('awaiting-sf', 'Awaiting SF Job', awaitingSf.items,
      i => `${i.customer_name ?? '—'} — ${i.days_waiting}d`),
    bucketize('estimates', 'Stale Estimates', stale.items,
      i => `${i.customer_name ?? '—'} — ${money(i.total)} — ${i.days_outstanding}d`),
    bucketize('followup', 'Follow-Up', followUp.items,
      i => `${i.customer_name ?? '—'} — ${i.days_open}d open`),
  ]

  // Online Scheduling has its own Done flow — every listed lead needs a first touch.
  const schedulingLines: Line[] = onlineScheduling.items.map(l => ({
    text: `${l.customer_name} — ${l.kind === 'synced' ? 'synced to SF' : 'partial'} — ${l.days_waiting}d`,
  }))

  // "Actioned today": button presses stamped today (PT) + Online Scheduling Done clicks today.
  const actionedTodayByLabel = new Map<string, number>()
  for (const a of actionRows ?? []) {
    if (ptDay(a.actioned_at) === today) {
      actionedTodayByLabel.set(a.action_label, (actionedTodayByLabel.get(a.action_label) ?? 0) + 1)
    }
  }
  const doneClicks = (acksToday ?? []).filter(a => ptDay(a.acknowledged_at) === today).length
  if (doneClicks > 0) actionedTodayByLabel.set('Online Scheduling Done', doneClicks)
  const actionedToday = [...actionedTodayByLabel.values()].reduce((s, n) => s + n, 0)

  return {
    buckets,
    schedulingLines,
    totalNew: buckets.reduce((s, b) => s + b.newLines.length, 0) + schedulingLines.length,
    totalDue: buckets.reduce((s, b) => s + b.dueLines.length, 0),
    actionedTodayByLabel,
    actionedToday,
  }
}

// ── Email rendering ──────────────────────────────────────────────────────────

const CAP = 10
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function renderLines(lines: Line[]): string {
  const shown = lines.slice(0, CAP)
  const more = lines.length - shown.length
  return shown.map(l =>
    `<li style="margin:2px 0;font-size:13px;color:#374151;">${esc(l.text)}${l.sub ? `<br/><span style="font-size:11px;color:#9ca3af;">${esc(l.sub)}</span>` : ''}</li>`,
  ).join('') + (more > 0 ? `<li style="font-size:12px;color:#9ca3af;">…and ${more} more</li>` : '')
}

function sectionHtml(title: string, groups: { label: string; lines: Line[] }[]): string {
  const withItems = groups.filter(g => g.lines.length > 0)
  if (withItems.length === 0) return ''
  return `<h2 style="font-size:15px;font-weight:700;margin:18px 0 6px;color:#111827;">${title}</h2>` +
    withItems.map(g =>
      `<p style="font-size:13px;font-weight:600;margin:10px 0 2px;color:#374151;">${esc(g.label)} (${g.lines.length})</p><ul style="margin:0;padding-left:18px;">${renderLines(g.lines)}</ul>`,
    ).join('')
}

export function dateLabelPT(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric',
  })
}

/** Assemble the digest email body. `introHtml`/`introText` slot in below the header. */
export function renderTodoEmail(d: TodoDigest, opts: {
  heading: string
  subtitle: string
  introHtml?: string
  introText?: string
}): { html: string; text: string } {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'
  const newGroups = [
    ...d.buckets.map(b => ({ label: b.label, lines: b.newLines })),
    { label: 'Online Scheduling (press Done after handling)', lines: d.schedulingLines },
  ]
  const dueGroups = d.buckets.map(b => ({ label: b.label, lines: b.dueLines }))

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;max-width:640px;margin:0 auto;padding:28px 22px;">
  <p style="font-size:19px;font-weight:700;margin:0 0 2px;">${esc(opts.heading)}</p>
  <p style="font-size:13px;color:#6b7280;margin:0 0 8px;">${esc(opts.subtitle)}</p>
  ${opts.introHtml ?? ''}
  ${sectionHtml('🆕 Needs first action', newGroups)}
  ${sectionHtml('🔔 Follow-ups due — actioned earlier, still unresolved', dueGroups)}
  <p style="margin:22px 0 0;">
    <a href="${appUrl}/admin/action-items" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Open Action Items →</a>
  </p>
</div>`.trim()

  const textParts: string[] = [opts.heading, opts.subtitle, '']
  if (opts.introText) textParts.push(opts.introText, '')
  const addText = (title: string, groups: { label: string; lines: Line[] }[]) => {
    const withItems = groups.filter(g => g.lines.length > 0)
    if (withItems.length === 0) return
    textParts.push(title)
    for (const g of withItems) {
      textParts.push(`  ${g.label} (${g.lines.length}):`)
      for (const l of g.lines.slice(0, CAP)) textParts.push(`    - ${l.text}${l.sub ? ` (${l.sub})` : ''}`)
      if (g.lines.length > CAP) textParts.push(`    …and ${g.lines.length - CAP} more`)
    }
    textParts.push('')
  }
  addText('NEEDS FIRST ACTION', newGroups)
  addText('FOLLOW-UPS DUE', dueGroups)
  textParts.push(`${appUrl}/admin/action-items`)

  return { html, text: textParts.join('\n') }
}
