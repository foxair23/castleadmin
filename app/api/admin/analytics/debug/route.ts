import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { ServiceFusionProvider } from '@/lib/crm/service-fusion'

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

  // 1. Check job total_amount in DB
  const { count: jobsWithAmount } = await db
    .from('sf_jobs_cache')
    .select('id', { count: 'exact', head: true })
    .not('total_amount', 'is', null)
    .gt('total_amount', 0)

  const { data: sampleJobs } = await db
    .from('sf_jobs_cache')
    .select('id, total_amount, completed_at')
    .eq('is_closed', true)
    .not('completed_at', 'is', null)
    .limit(5)

  // 2. Check invoice data in DB
  const { count: invoicesWithJobId } = await db
    .from('sf_invoices_cache')
    .select('id', { count: 'exact', head: true })
    .not('job_id', 'is', null)

  const { data: sampleInvoices } = await db
    .from('sf_invoices_cache')
    .select('id, job_id, customer_id, issued_at, total')
    .gt('total', 0)
    .limit(3)

  // 3. Fetch a live job from SF API to see if total field exists
  let sfJobKeys: string[] = []
  let sfJobTotal: unknown = null
  try {
    const provider = new ServiceFusionProvider()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await (provider as any).listJobsPaged(1, 1)
    const raw = resp.items[0] ?? null
    if (raw) {
      sfJobKeys = Object.keys(raw)
      sfJobTotal = raw.total
    }
  } catch (e) {
    sfJobKeys = [`error: ${e instanceof Error ? e.message : String(e)}`]
  }

  return NextResponse.json({
    db: { jobsWithAmount, sampleJobs, invoicesWithJobId, sampleInvoices },
    sfApi: { jobKeys: sfJobKeys, sampleJobTotal: sfJobTotal },
  })
}
