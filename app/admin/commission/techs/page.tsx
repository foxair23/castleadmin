import { Suspense } from 'react'
import { createServiceClient } from '@/lib/supabase/server'
import CommissionNav from '../CommissionNav'
import AdminTechDetailClient from './AdminTechDetailClient'

export default async function CommissionTechsPage() {
  const db = await createServiceClient()
  const { data: techs } = await db
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'technician').eq('is_active', true)
    .order('full_name')

  const todayStr = new Date().toISOString().slice(0, 10)

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Commission</h1>
      <p className="text-sm text-gray-500 mb-4">
        Review any technician&rsquo;s sales, pipeline, and earned/payable commission for a period.
      </p>
      <CommissionNav />
      <Suspense fallback={<div className="text-center text-gray-400 py-10">Loading…</div>}>
        <AdminTechDetailClient techs={techs ?? []} todayStr={todayStr} />
      </Suspense>
    </div>
  )
}
