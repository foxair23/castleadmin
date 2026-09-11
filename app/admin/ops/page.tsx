import { redirect } from 'next/navigation'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@/lib/supabase/server'
import { createClient as adminClient } from '@supabase/supabase-js'
import { loadHealthSnapshot, evaluateHealth } from '@/lib/ops/health'
import OpsHealthClient, { type RunRow, type CommandRow } from './OpsHealthClient'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Automation Health' }

function extensionVersion(): string {
  try { return JSON.parse(readFileSync(join(process.cwd(), 'chrome-extension/sf-remittance/manifest.json'), 'utf8')).version as string } catch { return '?' }
}

// The one page that says whether the office machine is doing its job: extension
// heartbeat, each portal's crawls, the SF session, the write queues, the app's own sync —
// green / amber / red — with the last 50 runs, remote buttons, and the leave-it-alone
// checklist. Admin-only.
export default async function OpsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/admin')

  const db = adminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const version = extensionVersion()
  const [snapshot, runsRes, cmdRes] = await Promise.all([
    loadHealthSnapshot(db, version),
    db.from('extension_runs').select('id, device, kind, site, mode, status, reason, source, started_at, finished_at, counts, log, version, created_at').order('created_at', { ascending: false }).limit(50),
    db.from('extension_commands').select('id, kind, args, status, created_at, claimed_at, finished_at, result').order('created_at', { ascending: false }).limit(20),
  ])
  const report = evaluateHealth(snapshot)
  const hb = snapshot.heartbeats.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))[0] ?? null
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <OpsHealthClient
        report={report}
        runs={(runsRes.data ?? []) as RunRow[]}
        commands={(cmdRes.data ?? []) as CommandRow[]}
        heartbeat={hb ? { device: hb.device, version: hb.version, last_seen_at: hb.last_seen_at, state: hb.state } : null}
        currentVersion={version}
      />
    </div>
  )
}
