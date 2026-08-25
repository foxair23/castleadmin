import VendorOrdersView from '../VendorOrdersView'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'HD Orders — Clopay' }

export default function ClopayHdPage() {
  return <VendorOrdersView canManage vendor="clopay_hd" basePath="/admin/vendor-orders" />
}
