import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

export const maxDuration = 60

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Check invoice data quality
  const { count: totalInvoices } = await db
    .from('sf_invoices_cache')
    .select('id', { count: 'exact', head: true })

  const { count: invoicesWithJobId } = await db
    .from('sf_invoices_cache')
    .select('id', { count: 'exact', head: true })
    .not('job_id', 'is', null)

  const { count: invoicesWithTotal } = await db
    .from('sf_invoices_cache')
    .select('id', { count: 'exact', head: true })
    .not('total', 'is', null)
    .gt('total', 0)

  // Sample a few invoices to see what fields are populated
  const { data: sampleInvoices } = await db
    .from('sf_invoices_cache')
    .select('id, job_id, customer_id, issued_at, total, balance_due')
    .limit(5)

  // Sample invoices that DO have a job_id
  const { data: invoicesWithJob } = await db
    .from('sf_invoices_cache')
    .select('id, job_id, total')
    .not('job_id', 'is', null)
    .gt('total', 0)
    .limit(5)

  return NextResponse.json({
    totalInvoices,
    invoicesWithJobId,
    invoicesWithTotal,
    sampleInvoices,
    invoicesWithJob,
  })
}
