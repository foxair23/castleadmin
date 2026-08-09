import VendorOrdersView from '@/app/admin/vendor-orders/VendorOrdersView'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'HD Orders' }

// Sales-facing HD Orders — same view as admin, rendered inside the /sales layout
// (which already guards admin+sales).
export default function SalesHdOrdersPage() {
  return <VendorOrdersView />
}
