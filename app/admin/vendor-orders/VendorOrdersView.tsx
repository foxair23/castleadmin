import { createClient as createAdminClient } from '@supabase/supabase-js'
import { VENDORS } from '@/lib/vendor-orders/config'
import { resolveSfJobMatches } from '@/lib/vendor-orders/sf-match'
import { getAutopilot } from '@/lib/vendor-orders/autopilot'
import { getNudgeSettings } from '@/lib/vendor-orders/schedule-nudge'
import VendorOrdersTable, { type VendorOrder } from './VendorOrdersTable'
import { AutopilotToggle } from './AutopilotToggle'
import { NudgeControls } from './NudgeControls'
import HdOrdersNav from './HdOrdersNav'
import { statusChipStyle, isTerminalStatus } from '@/lib/vendor-orders/status-style'

// Shared HD Orders view — rendered by both /admin/vendor-orders (admin) and
// /sales/hd-orders (sales), once per portal vendor. `vendor` selects which
// vendor_orders rows (and which scrape-run freshness) this tab shows; it defaults
// to Genie so the existing pages keep working unchanged. Data is service-role;
// each page guards its own role.
//
// Genie-only machinery (SF-job matching + create button, the schedule nudge, and
// autopilot) is gated to genie_thd. Other portal vendors (e.g. Clopay) are
// capture-only for now: the same table, minus the SF actions, plus a detail
// drawer fed from vendor_orders.raw.
export default async function VendorOrdersView({
  canManage = false,
  basePath = '/admin/vendor-orders',
  vendor = 'genie_thd',
}: { canManage?: boolean; basePath?: string; vendor?: string }) {
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const isGenie = vendor === 'genie_thd'
  // SF-job machinery (matching + create + autopilot) runs for the portal vendors
  // that create SF jobs — Genie and Clopay HD. The schedule nudge stays Genie-only
  // (only Genie has a customer self-scheduler).
  const sfEnabled = vendor === 'genie_thd' || vendor === 'clopay_hd'
  const shortName = (VENDORS[vendor]?.label || vendor).split(' — ')[0]

  const autopilot = sfEnabled ? await getAutopilot(vendor) : { enabled: false }
  const nudge = isGenie ? await getNudgeSettings() : { enabled: false, scheduleUrl: '' }
  const { data } = await db
    .from('vendor_orders')
    .select('id, external_id, status, next_step, order_type, customer_name, customer_po, store_number, order_date, schedule_date, street_address, city, state_prov, postal_code, phone, email, scope, sf_job_id, sf_created_job_number, detail_scraped_at, first_seen_at, last_seen_at, schedule_nudge_sent_at, raw')
    .eq('vendor', vendor)
    .order('first_seen_at', { ascending: false })
    .limit(1000)
  const base = (data ?? []) as VendorOrder[]

  // Last time each order's status changed (from the status_change events), for
  // the "Last Status Change" column + default sort. Chunk the id list to keep the
  // .in() query URL small.
  const orderIds = base.map(o => o.id)
  const lastStatusChange = new Map<string, string>()
  for (let i = 0; i < orderIds.length; i += 150) {
    const chunk = orderIds.slice(i, i + 150)
    const { data: ev } = await db
      .from('vendor_order_events')
      .select('order_id, created_at')
      .in('order_id', chunk)
      .eq('event_type', 'status_change')
      .order('created_at', { ascending: false })
    for (const e of (ev ?? []) as Array<{ order_id: string; created_at: string }>) {
      if (!lastStatusChange.has(e.order_id)) lastStatusChange.set(e.order_id, e.created_at)
    }
  }

  // Resolve each order's SF job via the shared matching service (PO → name →
  // email → phone). For Clopay the PO is the external_id (handled in the matcher).
  const matches = sfEnabled ? await resolveSfJobMatches(db, base) : new Map()
  const orders: VendorOrder[] = base.map(o => {
    const withLsc = { ...o, last_status_change_at: lastStatusChange.get(o.id) ?? null }
    const m = matches.get(o.id)
    if (m?.sfJobNumber) return { ...withLsc, sf_job_number: m.sfJobNumber, sf_match_method: m.method ?? null }
    if (o.sf_created_job_number) return { ...withLsc, sf_job_number: o.sf_created_job_number, sf_match_method: 'pending' }
    return { ...withLsc, sf_job_number: null, sf_match_method: null }
  })
  // Default order: most recent status change first (fall back to first seen).
  const sortValue = (o: VendorOrder) => o.last_status_change_at ?? o.first_seen_at
  orders.sort((a, b) => sortValue(b).localeCompare(sortValue(a)))

  const counts = orders.reduce<Record<string, number>>((a, o) => {
    const k = (o.status || 'unknown').toLowerCase().startsWith('open') ? 'Open' : (o.status || 'Unknown')
    a[k] = (a[k] || 0) + 1
    return a
  }, {})
  const needDetail = orders.filter(o => !o.detail_scraped_at).length

  // Last scrape from this vendor's portal — freshness + kind, so a broken scraper
  // (stale time, or an unexpectedly small order count) is obvious at a glance.
  // Filtered by vendor so each tab's banner reflects only its own crawler.
  const { data: runRow } = await db
    .from('vendor_scrape_runs')
    .select('mode, received, inserted, updated, status_changes, created_at')
    .eq('vendor', vendor)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const lastRun = runRow as { mode: string | null; received: number; inserted: number; updated: number; status_changes: number; created_at: string } | null
  // eslint-disable-next-line react-hooks/purity -- server render; wall-clock freshness is intentional
  const hoursSince = lastRun ? (Date.now() - new Date(lastRun.created_at).getTime()) / 3600000 : null
  const stale = hoursSince != null && hoursSince > 3
  const thin = lastRun != null && orders.length > 50 && lastRun.received < orders.length * 0.5
  const fmtRun = (s: string) => new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const rel = (h: number) => h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <HdOrdersNav base={basePath} />
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">HD Orders — {shortName}</h1>
        <div className="flex items-center gap-4">
          {isGenie && <NudgeControls on={nudge.enabled} scheduleUrl={nudge.scheduleUrl} canManage={canManage} />}
          {sfEnabled && <AutopilotToggle on={autopilot.enabled} canManage={canManage} vendor={vendor} label={`auto-create new ${shortName} jobs`} />}
          <span className="text-sm text-gray-500">{orders.length} total</span>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-3">
        Orders scraped from the {shortName} portal by the browser extension.
      </p>

      <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${stale || thin ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
        {lastRun ? (
          <span>
            {(stale || thin) && <span className="font-semibold">⚠ </span>}
            <span className="font-medium">Last {shortName} scrape:</span>{' '}
            {fmtRun(lastRun.created_at)} ({rel(hoursSince!)})
            {lastRun.mode && <> · <span className="uppercase text-xs tracking-wide">{lastRun.mode}</span></>}
            {' · '}{lastRun.received} orders
            <span className="text-gray-500"> ({lastRun.inserted} new, {lastRun.updated} updated, {lastRun.status_changes} status changes)</span>
            {stale && <span className="ml-1 font-medium">— stale, check the crawler</span>}
            {thin && <span className="ml-1 font-medium">— fewer orders than expected, check pagination</span>}
          </span>
        ) : (
          <span>No scrapes recorded yet — open the {shortName} order list with the extension installed.</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-sm">
        {Object.entries(counts).map(([k, n]) => (
          <span key={k} className={`px-2.5 py-1 rounded-full ${statusChipStyle(k)}`}>{k}: {n}</span>
        ))}
        {needDetail > 0 && <span className="px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">Awaiting detail: {needDetail}</span>}
      </div>

      {orders.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          No orders yet. Open the {shortName} portal with the extension installed — orders appear here on the next scrape.
        </div>
      ) : isGenie ? (
        <VendorOrdersTable orders={orders} enableSf={sfEnabled} enableNudge={isGenie} defaultSortKey="last_status_change_at" />
      ) : (
        // Clopay: split into Active vs Completed/Cancelled. Only "Install/Delivery
        // Completed" (and any cancelled) are terminal; everything else is active.
        <div className="space-y-8">
          <VendorOrdersTable
            orders={orders.filter(o => !isTerminalStatus(o.status))}
            enableSf={sfEnabled}
            enableNudge={false}
            title="Active Orders"
            defaultSortKey="last_status_change_at"
          />
          <VendorOrdersTable
            orders={orders.filter(o => isTerminalStatus(o.status))}
            enableSf={sfEnabled}
            enableNudge={false}
            title="Completed / Cancelled Orders"
            defaultSortKey="last_status_change_at"
          />
        </div>
      )}
    </div>
  )
}
