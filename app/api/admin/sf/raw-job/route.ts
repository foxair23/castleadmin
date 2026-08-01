import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const SF_BASE_URL = 'https://api.servicefusion.com/v1'

async function getToken(): Promise<string> {
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
  if (!resp.ok) throw new Error(`SF auth failed: ${resp.status}`)
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

  const jobNumber = req.nextUrl.searchParams.get('jobId')
  if (!jobNumber) return NextResponse.json({ error: 'jobId param required' }, { status: 400 })

  try {
    const token = await getToken()

    // First find the internal SF id by fetching the list filtered by number
    const listResp = await fetch(
      `${SF_BASE_URL}/jobs?filters[number]=${encodeURIComponent(jobNumber)}&per-page=1`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store' }
    )
    if (!listResp.ok) return NextResponse.json({ error: `SF list API ${listResp.status}` }, { status: listResp.status })
    const listJson = await listResp.json() as { items?: { id: number | string }[] }
    const internalId = listJson.items?.[0]?.id
    if (!internalId) return NextResponse.json({ error: 'Job number not found in SF', listJson }, { status: 404 })

    const auth = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store' as const }
    const getJson = async (path: string) => {
      const r = await fetch(`${SF_BASE_URL}${path}`, auth)
      if (!r.ok) return { _error: `${r.status}`, _body: await r.text().catch(() => '') }
      return r.json()
    }

    // Individual job WITH the line-item expands, plus the dedicated line-item
    // sub-resources — so we can see exactly where a job's priced products &
    // services live and what fields they carry.
    const raw = await getJson(`/jobs/${internalId}?expand=items,products,services`)
    const [products, services] = await Promise.all([
      getJson(`/jobs/${internalId}/products?per-page=100`),
      getJson(`/jobs/${internalId}/services?per-page=100`),
    ])

    return NextResponse.json({
      jobNumber,
      internalId,
      fields: raw && typeof raw === 'object' ? Object.keys(raw) : [],
      expand_items: raw?.items ?? null,
      expand_products: raw?.products ?? null,
      expand_services: raw?.services ?? null,
      subresource_products: products,
      subresource_services: services,
      raw,
    })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}

