import { createClient as createAdminClient } from '@supabase/supabase-js'
import { VENDORS } from '@/lib/vendor-orders/config'
import { resolveSfJobMatches } from '@/lib/vendor-orders/sf-match'
import { getAutopilot } from '@/lib/vendor-orders/autopilot'
import { getNudgeSettings } from '@/lib/vendor-orders/schedule-nudge'
import VendorOrdersTable, { type VendorOrder } from './VendorOrdersTable'
import { AutopilotToggle } from './AutopilotToggle'
import { NudgeControls } from './NudgeControls'

const statusStyle = (s: string | null) => {
  const k = (s || '').toLowerCase()
  if (k.startsWith('open')) return 'bg-green-100 text-green-800'
  if (k.startsWith('cancel')) return 'bg-red-100 text-red-700'
  if (k.startsWith('clos') || k.startsWith('complet')) return 'bg-gray-100 text-gray-500'
  return 'bg-amber-100 text-amber-800'
}

// Shared HD Orders view — rendered by both /admin/vendor-orders (admin) and
// /sales/hd-orders (sales). Data is service-role; each page guards its own role.
export default async function VendorOrdersView({ canManage = false }: { canManage?: boolean }) {
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const autopilot = await getAutopilot()
  const nudge = await getNudgeSettings()
  const { data } = await db
    .from('vendor_orders')
    .select('id, external_id, status, next_step, order_type, customer_name, customer_po, store_number, order_date, schedule_date, street_address, city, state_prov, postal_code, phone, email, scope, sf_job_id, sf_created_job_number, detail_scraped_at, first_seen_at, last_seen_at, schedule_nudge_sent_at')
    .order('first_seen_at', { ascending: false })
    .limit(1000)
  const base = (data ?? []) as VendorOrder[]

  // Resolve each order's SF job via the shared matching service (PO → name →
  // email → phone). If the mirror doesn't have it yet but we just created the job,
  // fall back to the captured number, flagged 'pending' (shown until the mirror
  // ingests it, then the real match takes over).
  const matches = await resolveSfJobMatches(db, base)
  const orders: VendorOrder[] = base.map(o => {
    const m = matches.get(o.id)
    if (m?.sfJobNumber) return { ...o, sf_job_number: m.sfJobNumber, sf_match_method: m.method ?? null }
    if (o.sf_created_job_number) return { ...o, sf_job_number: o.sf_created_job_number, sf_match_method: 'pending' }
    return { ...o, sf_job_number: null, sf_match_method: null }
  })

  const counts = orders.reduce<Record<string, number>>((a, o) => {
    const k = (o.status || 'unknown').toLowerCase().startsWith('open') ? 'Open' : (o.status || 'Unknown')
    a[k] = (a[k] || 0) + 1
    return a
  }, {})
  const needDetail = orders.filter(o => !o.detail_scraped_at).length

  // Last scrape from the vendor portal — freshness + kind, so a broken scraper
  // (stale time, or an unexpectedly small order count) is obvious at a glance.
  const { data: runRow } = await db
    .from('vendor_scrape_runs')
    .select('mode, received, inserted, updated, status_changes, created_at')
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
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">HD Orders</h1>
        <div className="flex items-center gap-4">
          <NudgeControls on={nudge.enabled} scheduleUrl={nudge.scheduleUrl} canManage={canManage} />
          <AutopilotToggle on={autopilot.enabled} canManage={canManage} />
          <span className="text-sm text-gray-500">{orders.length} total</span>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-3">
        Orders scraped from vendor portals by the browser extension.{' '}
        {Object.values(VENDORS).map(v => v.label).join(' · ') || 'No vendors configured.'}
      </p>

      <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${stale || thin ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
        {lastRun ? (
          <span>
            {(stale || thin) && <span className="font-semibold">⚠ </span>}
            <span className="font-medium">Last Genie scrape:</span>{' '}
            {fmtRun(lastRun.created_at)} ({rel(hoursSince!)})
            {lastRun.mode && <> · <span className="uppercase text-xs tracking-wide">{lastRun.mode}</span></>}
            {' · '}{lastRun.received} orders
            <span className="text-gray-500"> ({lastRun.inserted} new, {lastRun.updated} updated, {lastRun.status_changes} status changes)</span>
            {stale && <span className="ml-1 font-medium">— stale, check the crawler</span>}
            {thin && <span className="ml-1 font-medium">— fewer orders than expected, check pagination</span>}
          </span>
        ) : (
          <span>No scrapes recorded yet — open the Genie order list with the extension installed.</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-sm">
        {Object.entries(counts).map(([k, n]) => (
          <span key={k} className={`px-2.5 py-1 rounded-full ${statusStyle(k)}`}>{k}: {n}</span>
        ))}
        {needDetail > 0 && <span className="px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">Awaiting detail: {needDetail}</span>}
      </div>

      {orders.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          No orders yet. Open the Genie portal with the extension installed — orders appear here on the next scrape.
        </div>
      ) : (
        <VendorOrdersTable orders={orders} />
      )}
    </div>
  )
}
