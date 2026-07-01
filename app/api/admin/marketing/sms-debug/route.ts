import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { debugSms } from '@/lib/mailchimp/client'

export const maxDuration = 60

// Admin-only SMS diagnostic. Runs the exact SMS write path for a single
// contact and returns Mailchimp's raw responses so we can see why SMS isn't
// registering. Usage:
//   GET /api/admin/marketing/sms-debug?email=test@example.com&phone=7605551234

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Read params robustly (fall back to parsing the raw URL). Both are optional:
  // with no params the read-only checks (env, audiences, list) still run; pass
  // ?email= and ?phone= to also run the SMS write test.
  const params = req.nextUrl?.searchParams ?? new URL(req.url).searchParams
  const email = params.get('email')
  const phone = params.get('phone')

  const result = await debugSms(email, phone)
  return NextResponse.json({ ...result, usage: 'Add ?email=you@example.com&phone=9514668995 to run the SMS write test' }, { status: 200 })
}
