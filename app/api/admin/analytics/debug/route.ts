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

  // 1. Check what's in the DB
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

  const { data: sampleInvoices } = await db
    .from('sf_invoices_cache')
    .select('id, job_id, customer_id, issued_at, total')
    .gt('total', 0)
    .limit(3)

  // 2. Fetch a live invoice from SF API to see actual field names
  let sfInvoiceKeys: string[] = []
  let sfInvoiceSample: Record<string, unknown> | null = null
  try {
    const provider = new ServiceFusionProvider()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await (provider as any).listInvoicesPaged(1, 1)
    const raw = resp.items[0] ?? null
    if (raw) {
      sfInvoiceKeys = Object.keys(raw)
      sfInvoiceSample = raw
    }
  } catch (e) {
    sfInvoiceKeys = [`error: ${e instanceof Error ? e.message : String(e)}`]
  }

  return NextResponse.json({
    db: { totalInvoices, invoicesWithJobId, invoicesWithTotal, sampleInvoices },
    sfApi: { keys: sfInvoiceKeys, sample: sfInvoiceSample },
  })
}
