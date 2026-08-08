import { createClient as createAdminClient } from '@supabase/supabase-js'
import { VENDORS } from '@/lib/vendor-orders/config'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Vendor Orders' }

interface OrderRow {
  id: string
  vendor: string
  external_id: string
  status: string | null
  next_step: string | null
  order_type: string | null
  customer_name: string | null
  customer_po: string | null
  store_number: string | null
  order_date: string | null
  schedule_date: string | null
  street_address: string | null
  city: string | null
  state_prov: string | null
  postal_code: string | null
  phone: string | null
  email: string | null
  scope: string | null
  sf_job_id: string | null
  detail_scraped_at: string | null
  last_seen_at: string
}

const fmtDate = (s: string | null) =>
  s ? new Date(s + (s.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const fmtSeen = (s: string) =>
  new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

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
    .select('id, vendor, external_id, status, next_step, order_type, customer_name, customer_po, store_number, order_date, schedule_date, street_address, city, state_prov, postal_code, phone, email, scope, sf_job_id, detail_scraped_at, last_seen_at')
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(500)
  const orders = (data ?? []) as OrderRow[]

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
        <span className="text-sm text-gray-500">{orders.length} shown</span>
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
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                {['Order #', 'Status', 'Next Step', 'Customer', 'Address', 'Phone', 'Email', 'Scope', 'Order', 'Scheduled', 'PO', 'Store', 'SF Job', 'Seen'].map(h => (
                  <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white text-gray-900">
              {orders.map(o => (
                <tr key={o.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{o.external_id}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs ${statusStyle(o.status)}`}>{o.status || '—'}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.next_step || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{o.customer_name || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.street_address ? `${o.street_address}${o.city ? ', ' + o.city : ''}${o.state_prov ? ', ' + o.state_prov : ''}${o.postal_code ? ' ' + o.postal_code : ''}` : (o.city ? `${o.city}${o.state_prov ? ', ' + o.state_prov : ''}` : '—')}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.phone || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.email || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600 max-w-[200px] truncate" title={o.scope || ''}>{o.scope || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(o.order_date)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtDate(o.schedule_date)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.customer_po || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.store_number || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{o.sf_job_id ? <span className="text-green-700">✓</span> : <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-400 text-xs">{fmtSeen(o.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
