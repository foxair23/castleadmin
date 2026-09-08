import type { SupabaseClient } from '@supabase/supabase-js'
import type { RegressionCase, RegressionRun, WeekPoint } from './regression'

// Dashboard data (PRD §12): volume for the last 30 days, the regression set + runs,
// and the weekly edit / confusion trend the drift check reads.

export interface DashboardData {
  volume: { processed: number; drafted: number; autoSent: number; humanSent: number; dropped: number; escalated: number; superseded: number; medianMinutesToSend: number | null }
  cases: RegressionCase[]
  runs: RegressionRun[]
  trend: WeekPoint[]
}

const weekOf = (iso: string) => { const d = new Date(iso); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10) }

export async function loadDashboard(db: SupabaseClient): Promise<DashboardData> {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const since8w = new Date(Date.now() - 8 * 7 * 86_400_000).toISOString()
  const [{ data: msgs }, { data: replies }, { data: cases }, { data: runs }, { data: outcomes }, { data: trendReplies }] = await Promise.all([
    db.from('agent_email_messages').select('outcome').eq('direction', 'inbound').gte('created_at', since30).limit(5000),
    db.from('agent_email_replies').select('status, approval_path, was_edited, created_at, sent_at, message_id').gte('created_at', since30).limit(5000),
    db.from('agent_regression_cases').select('*').order('created_at', { ascending: false }).limit(200),
    db.from('agent_regression_runs').select('*').order('ran_at', { ascending: false }).limit(20),
    db.from('agent_email_outcomes').select('classification, created_at').gte('created_at', since8w).limit(5000),
    db.from('agent_email_replies').select('created_at, approval_path, was_edited, status').gte('created_at', since8w).limit(5000),
  ])
  const m = (msgs ?? []) as Array<{ outcome: string | null }>
  const r = (replies ?? []) as Array<{ status: string; approval_path: string | null; was_edited: boolean; created_at: string; sent_at: string | null; message_id: string }>
  const dropped = m.filter(x => (x.outcome ?? '').startsWith('dropped_')).length
  const autoSent = r.filter(x => x.status === 'sent' && x.approval_path === 'auto').length
  const humanSent = r.filter(x => x.status === 'sent' && x.approval_path !== 'auto').length
  // Time to send: received → sent, over sent replies whose message we can date.
  const recvBy = new Map<string, string>()
  if (r.length) {
    const ids = [...new Set(r.filter(x => x.sent_at).map(x => x.message_id))]
    if (ids.length) { const { data } = await db.from('agent_email_messages').select('id, received_at').in('id', ids); for (const x of data ?? []) if (x.received_at) recvBy.set(x.id as string, x.received_at as string) }
  }
  const mins = r.filter(x => x.sent_at && recvBy.get(x.message_id)).map(x => (Date.parse(x.sent_at!) - Date.parse(recvBy.get(x.message_id)!)) / 60_000).filter(v => v >= 0).sort((a, b) => a - b)
  const median = mins.length ? Math.round(mins[Math.floor(mins.length / 2)]) : null

  // Weekly trend: edit rate (edited / human-approved) and confusion (confused / classified).
  const byWeek = new Map<string, { drafts: number; approved: number; edited: number; classified: number; confused: number }>()
  const wk = (k: string) => { const v = byWeek.get(k) ?? { drafts: 0, approved: 0, edited: 0, classified: 0, confused: 0 }; byWeek.set(k, v); return v }
  for (const x of (trendReplies ?? []) as Array<{ created_at: string; approval_path: string | null; was_edited: boolean; status: string }>) {
    const w = wk(weekOf(x.created_at)); w.drafts++
    if (x.approval_path === 'approved' || x.approval_path === 'edited' || x.approval_path === 'chat_approved') { w.approved++; if (x.was_edited) w.edited++ }
  }
  for (const o of (outcomes ?? []) as Array<{ classification: string; created_at: string }>) { const w = wk(weekOf(o.created_at)); w.classified++; if (o.classification === 'confused') w.confused++ }
  const trend: WeekPoint[] = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, v]) => ({
    week, drafts: v.drafts, editRate: v.approved ? v.edited / v.approved : null, confusionRate: v.classified ? v.confused / v.classified : null,
  }))

  return {
    volume: { processed: m.length, drafted: r.length, autoSent, humanSent, dropped, escalated: r.filter(x => x.status === 'escalated').length, superseded: r.filter(x => x.status === 'superseded').length, medianMinutesToSend: median },
    cases: (cases ?? []) as RegressionCase[],
    runs: ((runs ?? []) as RegressionRun[]).map(x => ({ ...x, mean_score: x.mean_score == null ? null : Number(x.mean_score) })),
    trend,
  }
}
