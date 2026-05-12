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

  const jobId = req.nextUrl.searchParams.get('jobId')
  if (!jobId) return NextResponse.json({ error: 'jobId param required' }, { status: 400 })

  try {
    const token = await getToken()
    const resp = await fetch(`${SF_BASE_URL}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!resp.ok) return NextResponse.json({ error: `SF API ${resp.status}` }, { status: resp.status })
    const raw = await resp.json()
    return NextResponse.json({ fields: Object.keys(raw), raw })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}

