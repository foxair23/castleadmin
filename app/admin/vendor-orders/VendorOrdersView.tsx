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
import { attachmentsForOrders, signedUrls } from '@/lib/vendor-orders/attachments'
import { clopayPaymentsByPo } from '@/lib/vendor-orders/payments'

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

  // Independent head-of-render queries run concurrently (they were serial, adding
  // whole round-trips of dead time before the orders even arrived).
  const [autopilot, nudge, { data }, { data: runRow }] = await Promise.all([
    sfEnabled ? getAutopilot(vendor) : Promise.resolve({ enabled: false }),
    isGenie ? getNudgeSettings() : Promise.resolve({ enabled: false, scheduleUrl: '' }),
    // NOTE: no `raw` — the multi-KB jsonb per order dominated both the DB transfer and
    // the page payload. The drawer fetches it on demand; the Clopay display dates are
    // ingest-computed columns (derived_*, has_detail — migration 103).
    db.from('vendor_orders')
      .select('id, external_id, status, next_step, order_type, customer_name, customer_po, store_number, order_date, schedule_date, street_address, city, state_prov, postal_code, phone, email, scope, sf_job_id, sf_created_job_number, detail_scraped_at, first_seen_at, last_seen_at, schedule_nudge_sent_at, derived_order_date, derived_last_activity_at, has_detail, derived_total_fee, record_source, parent_order_id, dc_reserved_at, dc_last_seen_at')
      .eq('vendor', vendor)
      .order('first_seen_at', { ascending: false })
      .limit(1000),
    db.from('vendor_scrape_runs')
      .select('mode, received, inserted, updated, status_changes, created_at')
      .eq('vendor', vendor)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  const base = (data ?? []) as VendorOrder[]

  // Last time each order's status changed (from the status_change events), for
  // the "Last Status Change" column + default sort. Chunk the id list to keep each
  // .in() query URL small; the chunks are independent, so they run concurrently —
  // and in parallel with the SF-job match resolution below.
  const orderIds = base.map(o => o.id)
  const chunks: string[][] = []
  for (let i = 0; i < orderIds.length; i += 150) chunks.push(orderIds.slice(i, i + 150))
  const [matches, ...chunkResults] = await Promise.all([
    // Resolve each order's SF job via the shared matching service (PO → name →
    // email → phone). For Clopay the PO is the external_id (handled in the matcher).
    sfEnabled ? resolveSfJobMatches(db, base) : Promise.resolve(new Map()),
    ...chunks.map(chunk =>
      db.from('vendor_order_events')
        .select('order_id, created_at')
        .in('order_id', chunk)
        .eq('event_type', 'status_change')
        .order('created_at', { ascending: false })
        // Only the NEWEST event per order is used; newest-first + a generous cap keeps
        // the transfer bounded instead of hauling every order's full status history.
        .limit(2000)
        .then(r => (r.data ?? []) as Array<{ order_id: string; created_at: string }>),
    ),
  ])
  const lastStatusChange = new Map<string, string>()
  for (const evs of chunkResults) {
    for (const e of evs) if (!lastStatusChange.has(e.order_id)) lastStatusChange.set(e.order_id, e.created_at)
  }
  const orders: VendorOrder[] = base.map(o => {
    const withLsc = { ...o, last_status_change_at: lastStatusChange.get(o.id) ?? null }
    // Clopay: Order Date ← the "Order Received" milestone; Last Status Change ← the
    // most recent timestamp in the Summary/Notes — both ingest-computed columns now
    // (falls back to the status-change events when the detail hasn't been captured).
    if (vendor === 'clopay_hd') {
      if (o.derived_order_date) withLsc.order_date = o.derived_order_date
      if (o.derived_last_activity_at) withLsc.last_status_change_at = o.derived_last_activity_at
      // Total Fee from the current IPO (parsed from the stored PDF).
      withLsc.total_fee = o.derived_total_fee != null ? Number(o.derived_total_fee) : null
      // How long this order's product has sat at the DC, from the weekly DC report. The
      // reserved date exists in no other source, so without it the aging is invisible.
      withLsc.dc_reserved_at = o.dc_reserved_at ?? null
      withLsc.dc_last_seen_at = o.dc_last_seen_at ?? null
    }
    const m = matches.get(o.id)
    if (m?.sfJobNumber) return { ...withLsc, sf_job_number: m.sfJobNumber, sf_match_method: m.method ?? null }
    if (o.sf_created_job_number) return { ...withLsc, sf_job_number: o.sf_created_job_number, sf_match_method: 'pending' }
    return { ...withLsc, sf_job_number: null, sf_match_method: null }
  })
  // Stored document files (Clopay docs the crawler downloaded to our own storage).
  // Load them for the page's orders + batch-mint signed URLs so the drawer can link
  // to our copy instead of the Clopay site. Clopay-only (Genie has none).
  if (vendor === 'clopay_hd') {
    const attMap = await attachmentsForOrders(orders.map(o => o.id))
    const allPaths: string[] = []
    for (const rows of attMap.values()) for (const a of rows) allPaths.push(a.storage_path)
    const urls = await signedUrls(allPaths)
    for (const o of orders) {
      const rows = attMap.get(o.id) || []
      o.attachments = rows.map(a => ({
        id: a.id, filename: a.filename, mime_type: a.mime_type,
        external_ref: a.external_ref, url: urls.get(a.storage_path) ?? null,
      }))
    }
  }

  // Default order: most recent status change first (fall back to first seen).
  const sortValue = (o: VendorOrder) => o.last_status_change_at ?? o.first_seen_at
  orders.sort((a, b) => sortValue(b).localeCompare(sortValue(a)))

  // Multi-door jobs (migration 106): a house with several garage doors is several Clopay
  // orders — one per door, each with its own PO — bundled in one IPO and booked as ONE SF
  // job. Show one row per house: children fold into their primary, which already carries
  // the group's rolled-up Total Fee. The drawer lists each door.
  const doorCounts = new Map<string, number>()
  const childrenOf = new Map<string, VendorOrder[]>()
  for (const o of orders) {
    if (!o.parent_order_id) continue
    doorCounts.set(o.parent_order_id, (doorCounts.get(o.parent_order_id) ?? 0) + 1)
    const arr = childrenOf.get(o.parent_order_id) ?? []
    arr.push(o)
    childrenOf.set(o.parent_order_id, arr)
  }
  const topLevel = orders.filter(o => !o.parent_order_id)

  // What Clopay has actually paid, matched on PO. A row can be a whole group, so its figure
  // sums EVERY door's PO — the same roll-up Total Fee does. POs come from all orders, not
  // just the top-level ones: a child's PO is where that door's money is.
  let paidByOrder = new Map<string, number>()
  let poBreakdown = new Map<string, Array<{ po: string; amount: number }>>()
  if (vendor === 'clopay_hd') {
    const { byPo } = await clopayPaymentsByPo(db, orders.map(o => o.customer_po ?? ''))
    if (byPo.size) {
      paidByOrder = new Map()
      poBreakdown = new Map()
      for (const o of topLevel) {
        const parts: Array<{ po: string; amount: number }> = []
        for (const m of [o, ...(childrenOf.get(o.id) ?? [])]) {
          const po = (m.customer_po ?? '').trim()
          const amt = po ? byPo.get(po) : undefined
          if (amt) parts.push({ po, amount: amt })
        }
        if (parts.length) {
          paidByOrder.set(o.id, parts.reduce((a, p) => a + p.amount, 0))
          poBreakdown.set(o.id, parts)
        }
      }
    }
  }

  // `raw` never leaves the database now — the client just needs the has_detail flag
  // (the drawer fetches a row's raw on demand via getOrderDetailAction).
  const clientOrders: VendorOrder[] = topLevel.map(o => ({
    ...o,
    has_detail: o.has_detail === true,
    door_count: 1 + (doorCounts.get(o.id) ?? 0),
    payment_received: paidByOrder.get(o.id) ?? null,
    payment_pos: poBreakdown.get(o.id) ?? null,
  }))

  const counts = topLevel.reduce<Record<string, number>>((a, o) => {
    const k = (o.status || 'unknown').toLowerCase().startsWith('open') ? 'Open' : (o.status || 'Unknown')
    a[k] = (a[k] || 0) + 1
    return a
  }, {})
  const needDetail = topLevel.filter(o => !o.detail_scraped_at).length

  // Last scrape from this vendor's portal — freshness + kind, so a broken scraper
  // (stale time, or an unexpectedly small order count) is obvious at a glance.
  // Filtered by vendor so each tab's banner reflects only its own crawler.
  // (Fetched up top in the parallel batch.)
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
          <span className="text-sm text-gray-500">{topLevel.length} total</span>
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
        <VendorOrdersTable orders={clientOrders} enableSf={sfEnabled} enableNudge={isGenie} defaultSortKey="last_status_change_at" />
      ) : (
        // Clopay: split into Active vs Completed/Cancelled. Only "Install/Delivery
        // Completed" (and any cancelled) are terminal; everything else is active.
        <div className="space-y-8">
          <VendorOrdersTable
            orders={clientOrders.filter(o => !isTerminalStatus(o.status))}
            enableSf={sfEnabled}
            enableNudge={false}
            title="Active Orders"
            defaultSortKey="last_status_change_at"
          />
          <VendorOrdersTable
            orders={clientOrders.filter(o => isTerminalStatus(o.status))}
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
