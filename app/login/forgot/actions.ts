'use server'

import { createClient as createAdminClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { appUrl } from '@/lib/config/domains'

// "Forgot password?" The answer is the same whatever was typed — "if that address has an
// account, a link is on its way" — so the form cannot be used to find out which addresses
// belong to Castle staff. Supabase sends the email (a one-time link back to /auth/callback,
// which lands the person on /auth/reset with a short-lived session to set a new password).

export async function requestPasswordResetAction(rawEmail: string): Promise<{ ok: true }> {
  const email = (rawEmail ?? '').trim().toLowerCase()
  if (!email.includes('@')) return { ok: true }
  try {
    // A deactivated account gets no email at all: the person was let go, and a working
    // reset link is a way back in. Looked up with the service key so RLS does not matter.
    const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 })
    const user = users?.users.find(u => (u.email ?? '').toLowerCase() === email)
    if (!user) return { ok: true }
    const { data: profile } = await admin.from('profiles').select('is_active').eq('id', user.id).maybeSingle()
    if (!profile?.is_active) return { ok: true }

    // The anon server client, so the PKCE verifier lands in this browser's cookies and the
    // callback can exchange the code from the email link.
    const supabase = await createClient()
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${appUrl()}/auth/callback?next=/auth/reset` })
    if (error) console.error('[auth] reset email failed:', error.message)
  } catch (e) {
    console.error('[auth] reset request failed:', e instanceof Error ? e.message : e)
  }
  return { ok: true }
}
