import { createClient as createAdminClient } from '@supabase/supabase-js'
import { VENDORS } from '@/lib/vendor-orders/config'
import VendorOrdersTable, { type VendorOrder } from './VendorOrdersTable'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Vendor Orders' }

const statusStyle = (s: string | null) => {
  const k = (s || '').toLowerCase()
  if (k.startsWith('open')) return 'bg-green-100 text-green-800'
  if (k.startsWith('cancel')) return 'bg-red-100 text-red-700'
  if (k.startsWith('clos') || k.startsWith('complet')) return 'bg-gray-100 text-gray-500'
  return 'bg-amber-100 text-amber-800'
}

export default async function VendorOrdersPage() {
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data } = await db
    .from('vendor_orders')
    .select('id, external_id, status, next_step, order_type, customer_name, customer_po, store_number, order_date, schedule_date, street_address, city, state_prov, postal_code, phone, email, scope, sf_job_id, detail_scraped_at, last_seen_at')
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(1000)
  const orders = (data ?? []) as VendorOrder[]

  const counts = orders.reduce<Record<string, number>>((a, o) => {
    const k = (o.status || 'unknown').toLowerCase().startsWith('open') ? 'Open' : (o.status || 'Unknown')
    a[k] = (a[k] || 0) + 1
    return a
  }, {})
  const needDetail = orders.filter(o => !o.detail_scraped_at).length

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">Vendor Orders</h1>
        <span className="text-sm text-gray-500">{orders.length} total</span>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Orders scraped from vendor portals by the browser extension.{' '}
        {Object.values(VENDORS).map(v => v.label).join(' · ') || 'No vendors configured.'}
      </p>

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
