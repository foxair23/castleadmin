import { Suspense } from 'react'
import ClopayStsView from '@/app/admin/vendor-orders/ClopayStsView'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'HD Orders — Clopay STS' }

// Sales-facing Clopay STS — same view as admin, inside the /sales layout (which
// already guards admin+sales).
export default function SalesClopayStsPage() {
  return (
    <Suspense>
      <ClopayStsView basePath="/sales/hd-orders" />
    </Suspense>
  )
}
