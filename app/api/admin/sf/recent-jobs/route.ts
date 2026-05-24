import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as serviceClient } from '@supabase/supabase-js'

const SF_BASE_URL = 'https://api.servicefusion.com/v1'

async function getSfToken(): Promise<string> {
  const resp = await fetch('https://api.servicefusion.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
    }),
    cache: 'no-store',
  })
  if (!resp.ok) throw new Error(`SF auth failed: ${resp.status} ${await resp.text()}`)
  const json = await resp.json()
  return json.access_token as string
}

export const maxDuration = 30

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (p?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const perPage = req.nextUrl.searchParams.get('perPage') ?? '10'

  try {
    // ── 1. Recent SF jobs ───────────────────────────────────────────────────
    const token = await getSfToken()
    const sfResp = await fetch(
      `${SF_BASE_URL}/jobs?per-page=${perPage}&page=1`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store' }
    )
    if (!sfResp.ok) throw new Error(`SF jobs API ${sfResp.status}: ${await sfResp.text()}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sfJson = await sfResp.json() as any

    // ── 2. Recent synced leads from our DB ──────────────────────────────────
    const db = serviceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )
    const { data: leads } = await db
      .from('scheduler_leads')
      .select('id, customer_first_name, customer_last_name, sync_status, service_fusion_customer_id, service_fusion_job_id, synced_at, sync_attempts')
      .in('sync_status', ['synced', 'sync_failed', 'in_progress'])
      .order('synced_at', { ascending: false })
      .limit(10)

    // Show field names on the first job so we can see what SF actually uses
    const items = sfJson?.items ?? []
    const firstJobFields = items[0] ? Object.keys(items[0]) : []

    return NextResponse.json({
      sf_jobs: items,
      sf_meta: sfJson?._meta ?? null,
      first_job_field_names: firstJobFields,
      our_leads: leads ?? [],
    })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
