import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// One line per inbound email, whatever happens to it.
//
// Three routes share one receiving domain. Only two of them used to leave a trace, so a
// forwarded remittance that arrived and worked was indistinguishable from one that never
// came — and a post rejected on a stale token was invisible entirely. This makes all three
// outcomes legible.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface InboundLogFields {
  route: string
  recipient?: string | null
  from_addr?: string | null
  subject?: string | null
  resend_email_id?: string | null
  ok?: boolean | null
  detail?: string | null
}

const trim = (s: string | null | undefined, n: number) => (s == null ? null : String(s).slice(0, n))

/** Never throws: a diagnostic that can break the thing it is diagnosing is worse than none. */
export async function logInboundEmail(f: InboundLogFields): Promise<void> {
  try {
    await db().from('inbound_email_events').insert({
      route: f.route,
      recipient: trim(f.recipient, 500),
      from_addr: trim(f.from_addr, 320),
      subject: trim(f.subject, 500),
      resend_email_id: trim(f.resend_email_id, 200),
      ok: f.ok ?? null,
      detail: trim(f.detail, 1000),
    })
  } catch { /* diagnostics never break the path */ }
}

/** A post we turned away. These endpoints are public, so an open log is a way to flood the
 *  table from the internet: at most one rejection per route is recorded per window, which is
 *  all anyone needs to see that posts ARE arriving and being refused. */
const REJECT_WINDOW_MS = 15 * 60_000

export async function logRejectedInbound(route: string, detail: string): Promise<void> {
  try {
    const supabase = db()
    const since = new Date(Date.now() - REJECT_WINDOW_MS).toISOString()
    const { count } = await supabase.from('inbound_email_events')
      .select('id', { count: 'exact', head: true })
      .eq('route', 'rejected').eq('detail', detail).gte('received_at', since)
    if ((count ?? 0) > 0) return
    await supabase.from('inbound_email_events').insert({ route: 'rejected', ok: false, detail: trim(detail, 1000) })
  } catch { /* diagnostics never break the path */ }
}
