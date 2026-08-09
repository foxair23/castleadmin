import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createSfJobForOrder } from './create-sf-job'
import { resolveSfJobMatches } from './sf-match'

// Autopilot: when ON, a cron auto-creates the SF job for NEW Genie orders. Strict
// guards so it never touches the backlog or duplicates an existing job:
//   • only orders first seen AT/AFTER enabled_at (turning it on ignores history)
//   • only active orders (not Cancelled / Closed / Completed)
//   • not already created by us (sf_created_job_number null) or linked (sf_job_id null)
//   • not already matching an existing SF job (PO/name/email/phone) — no duplicates
//   • capped per run, gentle pacing — so a burst can't hammer SF

const VENDOR = 'genie_thd'
const CREATE_CAP = 15          // max jobs created per cron run
const LOOKAHEAD = 60           // candidates to match-check per run
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export interface AutopilotState { enabled: boolean; enabledAt: string | null }

export async function getAutopilot(vendor = VENDOR): Promise<AutopilotState> {
  const { data } = await db().from('vendor_autopilot').select('enabled, enabled_at').eq('vendor', vendor).maybeSingle()
  return { enabled: !!data?.enabled, enabledAt: data?.enabled_at ?? null }
}

export async function setAutopilot(vendor: string, enabled: boolean, userId: string | null): Promise<void> {
  const patch: Record<string, unknown> = { vendor, enabled, updated_at: new Date().toISOString(), updated_by: userId }
  // Stamp the cutoff each time it's turned ON, so the backlog is never swept.
  if (enabled) patch.enabled_at = new Date().toISOString()
  await db().from('vendor_autopilot').upsert(patch, { onConflict: 'vendor' })
}

const isActive = (status: string | null) => {
  const s = (status || '').toLowerCase()
  return !s.startsWith('cancel') && !s.startsWith('clos') && !s.startsWith('complet')
}

export interface AutopilotRunResult { enabled: boolean; created: number; failed: number; skippedMatched: number; remaining: number; errors: string[] }

export async function runGenieAutopilot(): Promise<AutopilotRunResult> {
  const ap = await getAutopilot()
  if (!ap.enabled || !ap.enabledAt) return { enabled: false, created: 0, failed: 0, skippedMatched: 0, remaining: 0, errors: [] }

  const supabase = db()
  const { data } = await supabase
    .from('vendor_orders')
    .select('id, status, customer_po, customer_name, email, phone, sf_job_id')
    .eq('vendor', VENDOR)
    .is('sf_job_id', null)
    .is('sf_created_job_number', null)
    .gte('first_seen_at', ap.enabledAt)     // new-only
    .order('first_seen_at', { ascending: true })
    .limit(300)

  const candidates = ((data ?? []) as Array<{ id: string; status: string | null; customer_po: string | null; customer_name: string | null; email: string | null; phone: string | null; sf_job_id: string | null }>)
    .filter(o => isActive(o.status))
    .slice(0, LOOKAHEAD)
  if (candidates.length === 0) return { enabled: true, created: 0, failed: 0, skippedMatched: 0, remaining: 0, errors: [] }

  // Never create a job for an order that already matches an existing SF job.
  const matches = await resolveSfJobMatches(supabase, candidates)
  const unmatched = candidates.filter(o => !matches.get(o.id)?.sfJobNumber)
  const skippedMatched = candidates.length - unmatched.length

  const batch = unmatched.slice(0, CREATE_CAP)
  let created = 0, failed = 0
  const errors: string[] = []
  for (const o of batch) {
    const res = await createSfJobForOrder(o.id)
    if (res.ok) created++
    else { failed++; if (res.error) errors.push(`${o.id}: ${res.error}`) }
    await sleep(1200) // be gentle on SF
  }

  return { enabled: true, created, failed, skippedMatched, remaining: Math.max(0, unmatched.length - batch.length), errors: errors.slice(0, 10) }
}
