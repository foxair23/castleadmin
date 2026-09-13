import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Where Supabase's emailed links land. Two link styles, depending on how the email
// template is written: `?code=` (the default ConfirmationURL, PKCE) is exchanged for a
// session here; `?token_hash=&type=` (a template using {{ .TokenHash }}) is verified
// directly. Either way the person ends up signed in and on `next` — for a password
// reset, /auth/reset. A bad or expired link goes back to the forgot page with a reason
// instead of to a blank error.
export async function GET(req: NextRequest) {
  const url = req.nextUrl
  const code = url.searchParams.get('code')
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type')
  const rawNext = url.searchParams.get('next') ?? '/'
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/'

  const supabase = await createClient()
  let failed: string | null = null
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) failed = error.message
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type: type as 'recovery' | 'email' | 'magiclink' | 'signup' | 'invite' | 'email_change', token_hash: tokenHash })
    if (error) failed = error.message
  } else {
    failed = 'missing code'
  }
  if (failed) {
    console.warn('[auth] callback failed:', failed)
    return NextResponse.redirect(new URL('/login/forgot?error=expired', url.origin))
  }
  return NextResponse.redirect(new URL(next, url.origin))
}
