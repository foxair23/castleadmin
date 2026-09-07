import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { agentDb, loadAgentSettings } from '@/lib/agent/settings'
import { getActiveCharter, listCharterVersions, listInstructions, listAnswers, listStyleExamples } from '@/lib/agent/knowledge'
import CassieClient from './CassieClient'
import { loadReviewItems } from '@/lib/agent/email/review'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Cassie' }

export default async function CassiePage({ searchParams }: { searchParams: Promise<{ reply?: string }> }) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/')

  const db = agentDb()
  // Charter/style reads seed defaults on first visit, so run them before the lists.
  const [settings, charter] = await Promise.all([loadAgentSettings(db), getActiveCharter(db)])
  const [versions, instructions, answers, styles] = await Promise.all([
    listCharterVersions(db),
    listInstructions(db, { includeRetired: true }),
    listAnswers(db, { includeInactive: true }),
    listStyleExamples(db),
  ])

  const gmailConfigured = !!process.env.GMAIL_REFRESH_TOKEN
  const reviewItems = await loadReviewItems(db, { statuses: ['draft', 'queued', 'sent', 'rejected', 'escalated', 'cancelled', 'superseded', 'failed'], limit: 300 })
  const [{ data: activity }, { data: draftRows }] = await Promise.all([
    db.from('agent_email_messages')
      .select('id, received_at, from_addr, from_name, subject, snippet, delivery_path, outcome, outcome_detail, gmail_thread_id')
      .order('received_at', { ascending: false }).limit(100),
    db.from('agent_email_replies')
      .select('id, message_id, status, question_type, question_summary, resolve_status, resolve_tier, sf_job_number, composed_subject, composed_text, unsourced_claims, hard_fail_reasons, claims, error, created_at')
      .order('created_at', { ascending: false }).limit(100),
  ])

  return (
    <CassieClient
      settings={settings}
      charter={charter}
      versions={versions.map(v => ({ ...v, body: v.is_active ? v.body : '' }))}
      instructions={instructions}
      answers={answers}
      styles={styles}
      gmailConfigured={gmailConfigured}
      activity={(activity ?? []) as never}
      drafts={(draftRows ?? []) as never}
      reviewItems={reviewItems}
      initialReply={sp.reply ?? null}
    />
  )
}
