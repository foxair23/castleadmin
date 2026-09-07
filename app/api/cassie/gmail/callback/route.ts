import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { agentDb, loadAgentSettings } from '@/lib/agent/settings'
import { exchangeCode, profileEmail, GMAIL_SCOPES } from '@/lib/agent/email/gmail'
import { appUrl } from '@/lib/config/domains'

export const dynamic = 'force-dynamic'

const back = (msg: string, ok = false) => NextResponse.redirect(`${appUrl()}/admin/cassie?gmail=${ok ? 'connected' : 'error'}&msg=${encodeURIComponent(msg)}`)

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return back('You were signed out of Castle Admin during the Google step. Sign in and try again.')
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return back('Admins only.')

  const url = new URL(req.url)
  const err = url.searchParams.get('error')
  if (err) return back(`Google returned: ${err}`)
  const code = url.searchParams.get('code'), state = url.searchParams.get('state')
  const jar = await cookies()
  const expected = jar.get('cassie_gmail_state')?.value
  jar.delete('cassie_gmail_state')
  if (!code || !state || !expected || state !== expected) return back('The authorization did not match this browser session. Please try Connect Gmail again.')

  try {
    const tok = await exchangeCode(code)
    const granted = tok.scope.split(/\s+/).filter(Boolean)
    const missing = GMAIL_SCOPES.filter(s => !granted.includes(s))
    if (missing.length) return back(`Google did not grant all permissions (${missing.map(s => s.split('/').pop()).join(', ')}). Tick every box on the consent screen.`)

    const db = agentDb()
    const [settings, prof] = await Promise.all([loadAgentSettings(db), profileEmail(tok.access_token)])
    if (prof.emailAddress.toLowerCase() !== settings.mailbox_address.toLowerCase()) {
      return back(`You signed in as ${prof.emailAddress}, but Cassie's mailbox is ${settings.mailbox_address}. Nothing was saved. Sign in as the Cassie account (or change the mailbox address in Settings first).`)
    }
    const now = new Date().toISOString()
    const { error } = await db.from('agent_gmail_credentials').upsert({ id: 1, email: prof.emailAddress, refresh_token: tok.refresh_token, scopes: granted, granted_by: user.id, granted_at: now, revoked_at: null })
    if (error) return back(`Could not store the credential: ${error.message}`)
    // Start incremental fetching from "now" so the first poll doesn't replay history.
    await db.from('agent_settings').update({ gmail_history_id: prof.historyId, gmail_last_ok_at: now, gmail_last_error: null, gmail_last_error_at: null }).eq('id', 1)
    return back(`Connected as ${prof.emailAddress}.`, true)
  } catch (e) {
    return back(e instanceof Error ? e.message : String(e))
  }
}
