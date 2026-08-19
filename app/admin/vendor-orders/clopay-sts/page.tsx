import { Suspense } from 'react'
import ClopayStsView from '../ClopayStsView'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'HD Orders — Clopay STS' }

export default function ClopayStsPage() {
  return (
    <Suspense>
      <ClopayStsView canManage basePath="/admin/vendor-orders" />
    </Suspense>
  )
}
