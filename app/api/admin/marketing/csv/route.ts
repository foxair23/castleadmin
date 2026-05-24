import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { fetchContactsForIds } from '../push/route'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return user
}

function escapeCsvField(value: string | null | undefined): string {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { customerIds } = body as { customerIds: string[] }

  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    return NextResponse.json({ error: 'customerIds must be a non-empty array' }, { status: 400 })
  }

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const contacts = await fetchContactsForIds(db, customerIds)

  const headers = ['Email', 'First Name', 'Last Name', 'Phone', 'City', 'Postal Code', 'Lead Source', 'Last Serviced Date']
  const rows: string[][] = [headers]

  for (const c of contacts) {
    rows.push([
      c.email,
      c.first_name ?? '',
      c.last_name ?? '',
      c.phone ?? '',
      c.city ?? '',
      c.postal_code ?? '',
      c.lead_source ?? '',
      c.last_serviced_date ?? '',
    ])
  }

  const csv = rows.map(row => row.map(escapeCsvField).join(',')).join('\n')
  const date = new Date().toISOString().slice(0, 10)

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="contacts-${date}.csv"`,
    },
  })
}
