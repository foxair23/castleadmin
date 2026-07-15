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
import { ACTION_TAB_CONFIG, ACQUISITION_CUTOFF, todayPT } from './config'

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
  /**
   * Every open backlog item across all tabs, keyed "tab:id" (post-acquisition
   * cutoff). Snapshotted daily so the morning email can diff against yesterday.
   * Unlike the buckets, this includes items in their follow-up window — an
   * actioned-but-unresolved item is still backlog until SF says it cleared.
   */
  backlogKeys: string[]
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
    dateOf?: (item: T) => string | null,
  ): TabBucket {
    const cfg = ACTION_TAB_CONFIG[tab]
    const out: TabBucket = { tab, label, newLines: [], dueLines: [] }
    for (const item of items) {
      // Pre-acquisition items are informational only — never in the to-do.
      const d = dateOf?.(item)
      if (d && d.slice(0, 10) < ACQUISITION_CUTOFF) continue
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

  // Same order as the Action Items tabs (Online Scheduling is prepended at
  // render time, ahead of these).
  const buckets: TabBucket[] = [
    bucketize('unpaid', 'Unpaid Jobs', unpaid.items,
      i => `${i.customer_name ?? '—'} — ${money(i.due_total)} due — ${i.days_outstanding}d`, i => i.closed_at),
    bucketize('uninvoiced', 'Never Invoiced', uninvoiced.items,
      i => `${i.customer_name ?? '—'} — ${money(i.total)} — ${i.days_since_completion}d`, i => i.closed_at),
    bucketize('accepted-no-job', 'Accepted Estimate - No Job', accepted.items,
      i => `${i.customer_name ?? '—'} — ${money(i.total)} — ${i.days_since_update}d`, i => i.created_at_sf),
    bucketize('estimates', 'Stale Estimates', stale.items,
      i => `${i.customer_name ?? '—'} — ${money(i.total)} — ${i.days_outstanding}d`, i => i.created_at_sf),
    bucketize('awaiting-sf', 'Marketing Lead - Awaiting SF Job', awaitingSf.items,
      i => `${i.customer_name ?? '—'} — ${i.days_waiting}d`, i => i.closed_at),
    bucketize('followup', 'Follow-Up', followUp.items,
      i => `${i.customer_name ?? '—'} — ${i.days_open}d open`, i => i.start_date),
  ]

  // Online Scheduling has its own Done flow — every listed lead needs a first touch.
  const schedulingLines: Line[] = onlineScheduling.items.map(l => ({
    text: `${l.customer_name} — ${l.kind === 'synced' ? 'synced to SF' : 'partial'} — ${l.days_waiting}d`,
  }))

  // Full open backlog keyed "tab:id" (post-cutoff, action state ignored). This
  // is what the daily snapshot diff compares — an item leaves the backlog only
  // when SF data clears it (paid, invoiced, converted, job created, …).
  const backlogKeys: string[] = []
  const addBacklog = <T extends { id: string }>(tab: string, items: T[], dateOf: (i: T) => string | null) => {
    for (const item of items) {
      const d = dateOf(item)
      if (d && d.slice(0, 10) < ACQUISITION_CUTOFF) continue
      backlogKeys.push(`${tab}:${item.id}`)
    }
  }
  addBacklog('unpaid', unpaid.items, i => i.closed_at)
  addBacklog('uninvoiced', uninvoiced.items, i => i.closed_at)
  addBacklog('accepted-no-job', accepted.items, i => i.created_at_sf)
  addBacklog('estimates', stale.items, i => i.created_at_sf)
  addBacklog('awaiting-sf', awaitingSf.items, i => i.closed_at)
  addBacklog('followup', followUp.items, i => i.start_date)
  addBacklog('online-scheduling', onlineScheduling.items, () => null)

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
    backlogKeys,
  }
}

// ── Yesterday synopsis (morning email only) ──────────────────────────────────

const TAB_LABELS: Record<string, string> = {
  'unpaid':            'Unpaid Jobs',
  'uninvoiced':        'Never Invoiced',
  'accepted-no-job':   'Accepted Estimate - No Job',
  'estimates':         'Stale Estimates',
  'awaiting-sf':       'Marketing Lead - Awaiting SF Job',
  'followup':          'Follow-Up',
  'online-scheduling': 'Online Scheduling',
}

export interface YesterdaySynopsis {
  /** False on the very first run (no prior snapshot) — day-over-day is N/A. */
  hasPrior: boolean
  clickedTotal: number
  clickedByLabel: Array<{ label: string; count: number }>
  closedTotal: number
  closedByTab: Array<{ label: string; count: number }>
  addedTotal: number
  backlogTotal: number
  /** today's backlog − yesterday's backlog (negative = shrinking = good). */
  netChange: number
}

/** PT calendar day, `offsetDays` from today (−1 = yesterday). */
function ptDayOffset(offsetDays: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86_400_000))
}

/**
 * Build the morning "what we accomplished yesterday" synopsis AND persist
 * today's backlog snapshot. Compares today's backlog (d.backlogKeys) against
 * yesterday's stored snapshot to find what SF cleared (closed) and what's new.
 * Must run once per day (the 7 AM cron) — it writes the snapshot for `today`.
 *
 * "Closed"/"added" are membership changes in the tracked backlog — the same
 * capped lists the emails act on (see alerts.ts limits). If a category ever
 * exceeds its cap, boundary churn can nudge the counts, but for this business's
 * post-cutoff volumes the numbers are directional-accurate for celebrating
 * progress and spotting a growing backlog.
 */
export async function computeYesterdaySynopsis(db: SupabaseClient, d: TodoDigest): Promise<YesterdaySynopsis> {
  const today = ptDayOffset(0)
  const yesterday = ptDayOffset(-1)

  // 1. Action-button presses stamped yesterday, + Online Scheduling Done clicks.
  const [{ data: actionRows }, { data: acks }, { data: snap }] = await Promise.all([
    db.from('action_item_actions').select('action_label, actioned_at')
      .gte('actioned_at', new Date(Date.now() - 60 * 3_600_000).toISOString()),
    db.from('scheduler_leads').select('acknowledged_at').not('acknowledged_at', 'is', null)
      .gte('acknowledged_at', new Date(Date.now() - 60 * 3_600_000).toISOString()),
    db.from('action_item_daily_snapshot').select('item_keys').eq('snapshot_date', yesterday).maybeSingle(),
  ])

  const clickedMap = new Map<string, number>()
  for (const a of actionRows ?? []) {
    if (ptDay(a.actioned_at) === yesterday) {
      clickedMap.set(a.action_label, (clickedMap.get(a.action_label) ?? 0) + 1)
    }
  }
  const doneClicks = (acks ?? []).filter(a => ptDay(a.acknowledged_at) === yesterday).length
  if (doneClicks > 0) clickedMap.set('Online Scheduling Done', doneClicks)
  const clickedByLabel = [...clickedMap.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
  const clickedTotal = clickedByLabel.reduce((s, x) => s + x.count, 0)

  // 2. Diff backlog snapshots.
  const todaySet = new Set(d.backlogKeys)
  const prevKeys: string[] | null = (snap?.item_keys as string[] | undefined) ?? null
  const hasPrior = prevKeys !== null
  const prevSet = new Set(prevKeys ?? [])

  const tabOf = (key: string) => key.slice(0, key.indexOf(':'))
  const groupByTab = (keys: string[]) => {
    const m = new Map<string, number>()
    for (const k of keys) m.set(tabOf(k), (m.get(tabOf(k)) ?? 0) + 1)
    return [...m.entries()]
      .map(([tab, count]) => ({ label: TAB_LABELS[tab] ?? tab, count }))
      .sort((a, b) => b.count - a.count)
  }

  const closedKeys = hasPrior ? [...prevSet].filter(k => !todaySet.has(k)) : []
  const addedKeys  = hasPrior ? [...todaySet].filter(k => !prevSet.has(k)) : []

  // 3. Persist today's snapshot (idempotent — a re-run overwrites the same day).
  await db.from('action_item_daily_snapshot')
    .upsert({ snapshot_date: today, item_keys: d.backlogKeys, total: d.backlogKeys.length }, { onConflict: 'snapshot_date' })

  return {
    hasPrior,
    clickedTotal,
    clickedByLabel,
    closedTotal: closedKeys.length,
    closedByTab: groupByTab(closedKeys),
    addedTotal: addedKeys.length,
    backlogTotal: todaySet.size,
    netChange: hasPrior ? todaySet.size - prevSet.size : 0,
  }
}

/** Render the synopsis as the intro block for the morning email. */
export function renderSynopsis(s: YesterdaySynopsis): { introHtml: string; introText: string } {
  const list = (rows: Array<{ label: string; count: number }>) =>
    rows.map(r => `${r.label} ×${r.count}`).join(' · ')

  // Net backlog indicator: down = shrinking (good), up = piling up.
  const net = s.netChange
  const netColor = net < 0 ? '#15803d' : net > 0 ? '#b91c1c' : '#4b5563'
  const netBg    = net < 0 ? '#f0fdf4' : net > 0 ? '#fef2f2' : '#f9fafb'
  const netBorder = net < 0 ? '#bbf7d0' : net > 0 ? '#fecaca' : '#e5e7eb'
  const netArrow = net < 0 ? '▼' : net > 0 ? '▲' : '■'
  const netWord  = net < 0 ? `down ${Math.abs(net)} — making a dent`
                 : net > 0 ? `up ${net} — piling up`
                 : 'flat'

  const tile = (bg: string, border: string, color: string, big: string, small: string) =>
    `<div style="flex:1;min-width:120px;background:${bg};border:1px solid ${border};border-radius:8px;padding:10px 14px;">
      <p style="font-size:22px;font-weight:700;color:${color};margin:0;">${big}</p>
      <p style="font-size:12px;color:${color};margin:2px 0 0;">${small}</p>
    </div>`

  const tiles = [
    tile('#f0fdf4', '#bbf7d0', '#15803d', `✅ ${s.clickedTotal}`,
      `actioned${s.clickedByLabel.length ? ` — ${esc(list(s.clickedByLabel))}` : ''}`),
  ]
  if (s.hasPrior) {
    tiles.push(
      tile('#eff6ff', '#bfdbfe', '#1d4ed8', `✔️ ${s.closedTotal}`,
        `cleared in SF${s.closedByTab.length ? ` — ${esc(list(s.closedByTab))}` : ''}`),
      tile('#fffbeb', '#fde68a', '#b45309', `➕ ${s.addedTotal}`, 'new items added'),
      tile(netBg, netBorder, netColor, `${netArrow} ${s.backlogTotal}`, `open backlog · ${netWord}`),
    )
  } else {
    tiles.push(
      tile('#f9fafb', '#e5e7eb', '#4b5563', `📋 ${s.backlogTotal}`, 'open backlog · day-over-day starts tomorrow'),
    )
  }

  const introHtml = `
  <div style="margin:10px 0 6px;">
    <p style="font-size:13px;font-weight:700;color:#111827;margin:0 0 6px;">Yesterday’s progress</p>
    <div style="display:flex;flex-wrap:wrap;gap:10px;">${tiles.join('')}</div>
  </div>`

  const parts = [`Yesterday: ✅ ${s.clickedTotal} actioned${s.clickedByLabel.length ? ` (${list(s.clickedByLabel)})` : ''}`]
  if (s.hasPrior) {
    parts.push(
      `✔️ ${s.closedTotal} cleared in SF${s.closedByTab.length ? ` (${list(s.closedByTab)})` : ''}`,
      `➕ ${s.addedTotal} added`,
      `Open backlog: ${s.backlogTotal} (${netWord})`,
    )
  } else {
    parts.push(`Open backlog: ${s.backlogTotal} — day-over-day tracking starts tomorrow`)
  }

  return { introHtml, introText: parts.join(' · ') }
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

interface Group { label: string; lines: Line[]; tab: string }

function sectionHtml(title: string, groups: Group[], appUrl: string): string {
  const withItems = groups.filter(g => g.lines.length > 0)
  if (withItems.length === 0) return ''
  return `<h2 style="font-size:15px;font-weight:700;margin:18px 0 6px;color:#111827;">${title}</h2>` +
    withItems.map(g => {
      const href = `${appUrl}/sales/action-items?tab=${encodeURIComponent(g.tab)}`
      const label = `<a href="${href}" style="color:#dc2626;text-decoration:none;">${esc(g.label)} (${g.lines.length}) →</a>`
      return `<p style="font-size:13px;font-weight:600;margin:10px 0 2px;color:#374151;">${label}</p><ul style="margin:0;padding-left:18px;">${renderLines(g.lines)}</ul>`
    }).join('')
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
  // Link to /sales/action-items, not /admin: the digest goes to both admin and
  // sales recipients, and this page renders the same Action Items UI for both
  // roles. /admin/action-items would bounce sales users through an
  // admin→tech→admin redirect loop ("this page isn't working").
  const newGroups: Group[] = [
    { label: 'Online Scheduling (press Done after handling)', lines: d.schedulingLines, tab: 'online-scheduling' },
    ...d.buckets.map(b => ({ label: b.label, lines: b.newLines, tab: b.tab })),
  ]
  const dueGroups: Group[] = d.buckets.map(b => ({ label: b.label, lines: b.dueLines, tab: b.tab }))

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;max-width:640px;margin:0 auto;padding:28px 22px;">
  <p style="font-size:19px;font-weight:700;margin:0 0 2px;">${esc(opts.heading)}</p>
  <p style="font-size:13px;color:#6b7280;margin:0 0 8px;">${esc(opts.subtitle)}</p>
  ${opts.introHtml ?? ''}
  ${sectionHtml('🆕 Needs first action', newGroups, appUrl)}
  ${sectionHtml('🔔 Follow-ups due — actioned earlier, still unresolved', dueGroups, appUrl)}
  <p style="margin:22px 0 0;">
    <a href="${appUrl}/sales/action-items" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Open Action Items →</a>
  </p>
</div>`.trim()

  const textParts: string[] = [opts.heading, opts.subtitle, '']
  if (opts.introText) textParts.push(opts.introText, '')
  const addText = (title: string, groups: Group[]) => {
    const withItems = groups.filter(g => g.lines.length > 0)
    if (withItems.length === 0) return
    textParts.push(title)
    for (const g of withItems) {
      textParts.push(`  ${g.label} (${g.lines.length}) — ${appUrl}/sales/action-items?tab=${g.tab}`)
      for (const l of g.lines.slice(0, CAP)) textParts.push(`    - ${l.text}${l.sub ? ` (${l.sub})` : ''}`)
      if (g.lines.length > CAP) textParts.push(`    …and ${g.lines.length - CAP} more`)
    }
    textParts.push('')
  }
  addText('NEEDS FIRST ACTION', newGroups)
  addText('FOLLOW-UPS DUE', dueGroups)
  textParts.push(`${appUrl}/sales/action-items`)

  return { html, text: textParts.join('\n') }
}
