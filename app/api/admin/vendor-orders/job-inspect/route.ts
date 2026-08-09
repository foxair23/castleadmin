import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as adminClient } from '@supabase/supabase-js'
import { sfGet } from '@/lib/crm/service-fusion'

export const dynamic = 'force-dynamic'

// Admin debug: fetch a job straight from the SF API with custom_fields + services
// expanded, so we can see exactly how a manually-made HD job represents those
// (to match the create payload). Usage: /api/admin/vendor-orders/job-inspect?number=1020257499
async function isAdmin(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  return data?.role === 'admin'
}

export async function GET(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const number = req.nextUrl.searchParams.get('number')
  if (!number) return NextResponse.json({ error: 'pass ?number=<job number>' }, { status: 400 })

  const db = adminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: job } = await db.from('sf_jobs').select('id').eq('number', number).maybeSingle()
  if (!job) return NextResponse.json({ error: `job ${number} not found in mirror` }, { status: 404 })

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await sfGet(`/jobs/${job.id}`, { expand: 'custom_fields,services' })) as any
    return NextResponse.json({
      id: job.id,
      number,
      category: resp?.category ?? null,
      source: resp?.source ?? null,
      custom_fields: resp?.custom_fields ?? null,
      services: resp?.services ?? null,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
