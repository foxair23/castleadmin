import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { randomBytes } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { authorizeUrl, isGoogleOAuthConfigured } from '@/lib/agent/email/gmail'

export const dynamic = 'force-dynamic'

// Admin → Cassie → Settings → "Connect Gmail". Sends the admin to Google's consent
// screen. They must sign in AS THE CASSIE ACCOUNT; the callback refuses any other
// account so a personal mailbox can never be wired in by mistake.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login?next=/admin/cassie', process.env.NEXT_PUBLIC_APP_URL ?? 'https://hq.castlegarage.com'))
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403 })
  if (!isGoogleOAuthConfigured()) return NextResponse.json({ error: 'GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET are not set in Vercel.' }, { status: 500 })

  const state = randomBytes(24).toString('base64url')
  const jar = await cookies()
  jar.set('cassie_gmail_state', state, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 })
  return NextResponse.redirect(authorizeUrl(state))
}
