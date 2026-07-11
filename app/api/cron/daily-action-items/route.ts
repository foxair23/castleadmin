import { NextRequest, NextResponse } from 'next/server'
import {
  getUnpaidJobs,
  getUninvoicedJobs,
  getStaleEstimates,
  getFollowUpJobs,
  getAwaitingSfJob,
  getOnlineSchedulingLeads,
  getAcceptedEstimatesAwaitingJob,
} from '@/lib/analytics/alerts'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { ACTION_TAB_CONFIG, todayPT } from '@/lib/action-items/config'

export const maxDuration = 300

// Daily Action Items to-do digest (Mon–Sat, after the morning SF syncs).
// Two buckets per tab:
//   🆕 Needs first action — on the list, no action recorded yet
//   🔔 Follow-ups due     — actioned, follow-up date reached, still unresolved
// Items inside their follow-up window ("waiting") are excluded — the email is
// only what someone must do today.

interface Line { text: string; sub?: string }
interface TabBucket { tab: string; label: string; newLines: Line[]; dueLines: Line[] }

const money = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const started = Date.now()

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const [unpaid, uninvoiced, stale, followUp, awaitingSf, onlineScheduling, accepted, { data: actionRows }] =
    await Promise.all([
      getUnpaidJobs(),
      getUninvoicedJobs(),
      getStaleEstimates(),
      getFollowUpJobs(),
      getAwaitingSfJob(),
      getOnlineSchedulingLeads(),
      getAcceptedEstimatesAwaitingJob(),
      db.from('action_item_actions').select('entity_type, entity_id, action_label, actioned_at, follow_up_on'),
    ])

  const today = todayPT()
  const actionByKey = new Map(
    (actionRows ?? []).map(a => [`${a.entity_type}:${a.entity_id}`, a]),
  )

  function bucketize<T extends { id: string }>(
    tab: string,
    label: string,
    items: T[],
    line: (item: T) => string,
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
      // else: waiting — excluded
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

  const totalNew = buckets.reduce((s, b) => s + b.newLines.length, 0) + schedulingLines.length
  const totalDue = buckets.reduce((s, b) => s + b.dueLines.length, 0)

  if (totalNew === 0 && totalDue === 0) {
    return NextResponse.json({ ok: true, skipped: 'nothing to do', ms: Date.now() - started })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'
  const dateLabel = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric',
  })
  const subject = `Action Items To-Do — ${dateLabel}: ${totalNew} need first action, ${totalDue} follow-up${totalDue === 1 ? '' : 's'} due`

  const CAP = 10
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const renderLines = (lines: Line[]) => {
    const shown = lines.slice(0, CAP)
    const more = lines.length - shown.length
    return shown.map(l =>
      `<li style="margin:2px 0;font-size:13px;color:#374151;">${esc(l.text)}${l.sub ? `<br/><span style="font-size:11px;color:#9ca3af;">${esc(l.sub)}</span>` : ''}</li>`,
    ).join('') + (more > 0 ? `<li style="font-size:12px;color:#9ca3af;">…and ${more} more</li>` : '')
  }

  const sectionHtml = (title: string, groups: { label: string; lines: Line[] }[]) => {
    const withItems = groups.filter(g => g.lines.length > 0)
    if (withItems.length === 0) return ''
    return `<h2 style="font-size:15px;font-weight:700;margin:18px 0 6px;color:#111827;">${title}</h2>` +
      withItems.map(g =>
        `<p style="font-size:13px;font-weight:600;margin:10px 0 2px;color:#374151;">${esc(g.label)} (${g.lines.length})</p><ul style="margin:0;padding-left:18px;">${renderLines(g.lines)}</ul>`,
      ).join('')
  }

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;max-width:640px;margin:0 auto;padding:28px 22px;">
  <p style="font-size:19px;font-weight:700;margin:0 0 2px;">Today&rsquo;s Action Items To-Do</p>
  <p style="font-size:13px;color:#6b7280;margin:0 0 8px;">${esc(dateLabel)} · ${totalNew} need a first action · ${totalDue} follow-up${totalDue === 1 ? '' : 's'} due</p>
  ${sectionHtml('🆕 Needs first action', [
    ...buckets.map(b => ({ label: b.label, lines: b.newLines })),
    { label: 'Online Scheduling (press Done after handling)', lines: schedulingLines },
  ])}
  ${sectionHtml('🔔 Follow-ups due — actioned earlier, still unresolved', buckets.map(b => ({ label: b.label, lines: b.dueLines })))}
  <p style="margin:22px 0 0;">
    <a href="${appUrl}/admin/action-items" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Open Action Items →</a>
  </p>
</div>`.trim()

  const textParts: string[] = [`Today's Action Items To-Do — ${dateLabel}`, '']
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
  addText('NEEDS FIRST ACTION', [
    ...buckets.map(b => ({ label: b.label, lines: b.newLines })),
    { label: 'Online Scheduling', lines: schedulingLines },
  ])
  addText('FOLLOW-UPS DUE', buckets.map(b => ({ label: b.label, lines: b.dueLines })))
  textParts.push(`${appUrl}/admin/action-items`)

  const queued = await enqueueForSubscribers({
    notificationTypeKey: 'daily_action_items_todo',
    subject,
    bodyHtml: html,
    bodyText: textParts.join('\n'),
  })

  return NextResponse.json({ ok: true, totalNew, totalDue, queued, ms: Date.now() - started })
}
