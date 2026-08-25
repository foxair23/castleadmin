import VendorOrdersView from '@/app/admin/vendor-orders/VendorOrdersView'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'HD Orders — Clopay' }

// Sales-facing Clopay HD Program orders — same view as admin, rendered inside the
// /sales layout (which already guards admin+sales).
export default function SalesClopayHdPage() {
  return <VendorOrdersView vendor="clopay_hd" basePath="/sales/hd-orders" />
}
