'use client'

import { Fragment, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AgentSettings, QuestionType } from '@/lib/agent/settings'
import type { Charter, Instruction, AnswerEntry, StyleExample } from '@/lib/agent/knowledge'
import type { ReviewItem } from '@/lib/agent/email/review'
import ReviewTab from './ReviewTab'
import {
  saveAgentSettings, saveCharter, activateCharter,
  createInstruction, retireInstructionAction, reactivateInstructionAction,
  saveAnswer, setAnswerActiveAction,
  createStyleExample, pinStyleExample, removeStyleExample, replayPastedEmail,
} from './actions'

export interface DraftRow {
  id: string; message_id: string; status: string; question_type: string | null; question_summary: string | null
  resolve_status: string | null; resolve_tier: string | null; sf_job_number: string | null
  composed_subject: string | null; composed_text: string | null; unsourced_claims: string[]; hard_fail_reasons: string[]
  claims: Array<{ text: string; factIds: string[]; grounded: boolean; unsupported: string[] }>; error: string | null; created_at: string
}

export interface GmailStatus {
  connected: boolean; email: string | null; grantedAt: string | null; source: 'db' | 'env' | null; oauthReady: boolean; redirectUri: string
  lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null
}

export interface ActivityRow {
  id: string; received_at: string | null; from_addr: string | null; from_name: string | null; subject: string | null
  snippet: string | null; delivery_path: string | null; outcome: string | null; outcome_detail: string | null; gmail_thread_id: string | null
}

// Admin → Cassie. The shared agent knowledge (charter, standing instructions, answer
// library, style corpus) plus the settings row. The review queue, sent log and
// dashboard arrive in later chunks as more tabs here.

const input = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 bg-white'
const btn = 'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50'
const btnGhost = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const card = 'rounded-lg border border-gray-200 bg-white p-4'

const QUESTION_TYPES: { value: QuestionType | ''; label: string }[] = [
  { value: '', label: '— any —' },
  { value: 'schedule', label: 'Schedule / when' }, { value: 'completion', label: 'Completed?' },
  { value: 'tech', label: 'Which technician' }, { value: 'status', label: 'Current status' },
  { value: 'material', label: 'Material / parts' }, { value: 'ship_date', label: 'Ship date' },
  { value: 'pricing', label: 'Pricing / invoice' }, { value: 'warranty', label: 'Warranty' },
  { value: 'reschedule', label: 'Reschedule request' }, { value: 'complaint', label: 'Complaint' },
  { value: 'other', label: 'Other' },
]

function fmt(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const lines = (arr: string[]) => arr.join('\n')
const parseLines = (s: string) => s.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean)

type Tab = 'review' | 'activity' | 'settings' | 'charter' | 'instructions' | 'answers' | 'style'

export default function CassieClient(props: {
  settings: AgentSettings
  charter: Charter
  versions: Charter[]
  instructions: Instruction[]
  answers: AnswerEntry[]
  styles: StyleExample[]
  gmailConfigured: boolean
  activity: ActivityRow[]
  drafts: DraftRow[]
  reviewItems: ReviewItem[]
  initialReply: string | null
  gmail: GmailStatus
  gmailFlash: { ok: boolean; msg: string } | null
}) {
  const [tab, setTab] = useState<Tab>('review')
  const needsReview = props.reviewItems.filter(i => i.status === 'draft').length
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'review', label: 'Review', count: needsReview },
    { key: 'activity', label: 'Activity', count: props.activity.length },
    { key: 'settings', label: 'Settings' },
    { key: 'charter', label: 'Charter' },
    { key: 'instructions', label: 'Standing Instructions', count: props.instructions.filter(i => i.is_active).length },
    { key: 'answers', label: 'Answer Library', count: props.answers.filter(a => a.is_active).length },
    { key: 'style', label: 'Style Examples', count: props.styles.length },
  ]
  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold text-gray-900">Cassie</h1>
        <p className="text-sm text-gray-500">Castle&apos;s AI agent — partner email status replies. Everything here is shared by every channel Cassie works in.</p>
      </div>
      <div className="flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === t.key ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
            {t.label}{t.count != null && <span className="ml-1.5 text-xs text-gray-400">{t.count}</span>}
          </button>
        ))}
      </div>
      {tab === 'review' && <ReviewTab items={props.reviewItems} gmailConfigured={props.gmailConfigured} initialOpen={props.initialReply} />}
      {tab === 'activity' && <ActivityTab rows={props.activity} drafts={props.drafts} />}
      {tab === 'settings' && <SettingsTab settings={props.settings} gmailConfigured={props.gmailConfigured} gmail={props.gmail} gmailFlash={props.gmailFlash} />}
      {tab === 'charter' && <CharterTab charter={props.charter} versions={props.versions} />}
      {tab === 'instructions' && <InstructionsTab rows={props.instructions} />}
      {tab === 'answers' && <AnswersTab rows={props.answers} />}
      {tab === 'style' && <StyleTab rows={props.styles} />}
    </div>
  )
}

// ── Activity + replay ───────────────────────────────────────────────────────

const OUTCOME_LABEL: Record<string, { label: string; cls: string }> = {
  accepted: { label: 'Accepted — awaiting composer', cls: 'bg-blue-50 text-blue-700' },
  drafted: { label: 'Draft — not sent', cls: 'bg-amber-100 text-amber-800' },
  queued: { label: 'Queued', cls: 'bg-purple-100 text-purple-800' },
  sent: { label: 'Sent', cls: 'bg-green-100 text-green-800' },
  human_reply: { label: 'Castle staff wrote', cls: 'bg-gray-100 text-gray-700' },
  partner_reply: { label: 'Partner follow-up', cls: 'bg-indigo-50 text-indigo-700' },
  error: { label: 'Error', cls: 'bg-red-100 text-red-800' },
}
function outcomeBadge(o: string | null) {
  if (!o) return { label: '—', cls: 'bg-gray-100 text-gray-500' }
  if (o.startsWith('dropped_')) return { label: `Dropped — ${o.slice(8).replace(/_/g, ' ')}`, cls: 'bg-gray-100 text-gray-600' }
  return OUTCOME_LABEL[o] ?? { label: o, cls: 'bg-gray-100 text-gray-600' }
}

const SAMPLE_BODY = `Hi Castle,

Can you give me a status on PO 1020259181? Customer is asking when the install is scheduled.

Thanks,
Store 6614`

function ActivityTab({ rows, drafts }: { rows: ActivityRow[]; drafts: DraftRow[] }) {
  const draftByMessage = new Map(drafts.map(d => [d.message_id, d]))
  const [openDraft, setOpenDraft] = useState<string | null>(null)
  const router = useRouter()
  const [pending, start] = useTransition()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ from: 'store.manager@homedepot.com', to: 'info@castlegarage.com', cc: '', subject: 'PO 1020259181 status', body: SAMPLE_BODY, autoReply: false, threadId: '' })
  const [result, setResult] = useState<{ outcome: string; detail?: string } | null>(null)
  return (
    <div className="space-y-4">
      <div className={card}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Replay a pasted email</h2>
            <p className="text-xs text-gray-500">Runs a message through the same pipeline real mail will use — allowlist, auto-reply detection, loop protection, thread rules — and logs the outcome below. Nothing is sent. Use it to check your allowlist and, once the composer is live, to preview drafts before any mailbox is connected.</p>
          </div>
          <button className={btnGhost} onClick={() => setOpen(v => !v)}>{open ? 'Close' : 'Open'}</button>
        </div>
        {open && (
          <div className="mt-3 grid sm:grid-cols-2 gap-3">
            <Field label="From"><input className={input} value={f.from} onChange={e => setF(x => ({ ...x, from: e.target.value }))} /></Field>
            <Field label="Subject"><input className={input} value={f.subject} onChange={e => setF(x => ({ ...x, subject: e.target.value }))} /></Field>
            <Field label="To"><input className={input} value={f.to} onChange={e => setF(x => ({ ...x, to: e.target.value }))} /></Field>
            <Field label="CC"><input className={input} value={f.cc} onChange={e => setF(x => ({ ...x, cc: e.target.value }))} /></Field>
            <div className="sm:col-span-2"><Field label="Body"><textarea rows={7} className={input} value={f.body} onChange={e => setF(x => ({ ...x, body: e.target.value }))} /></Field></div>
            <label className="flex items-center gap-2 text-sm text-gray-800"><input type="checkbox" checked={f.autoReply} onChange={e => setF(x => ({ ...x, autoReply: e.target.checked }))} /> Mark as an auto-reply (Auto-Submitted header)</label>
            <Field label="Thread key" hint="reuse the same key to simulate a second message in one thread"><input className={input} value={f.threadId} onChange={e => setF(x => ({ ...x, threadId: e.target.value }))} placeholder="optional, e.g. test-1" /></Field>
            <div className="sm:col-span-2 flex items-center gap-3">
              <button className={btn} disabled={pending} onClick={() => start(async () => {
                setResult(null)
                try { setResult(await replayPastedEmail(f)); router.refresh() } catch (e) { setResult({ outcome: 'error', detail: e instanceof Error ? e.message : String(e) }) }
              })}>Run through pipeline</button>
              {result && (() => { const b = outcomeBadge(result.outcome); return (
                <span className="text-sm"><span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${b.cls}`}>{b.label}</span>{result.detail && <span className="ml-2 text-gray-600">{result.detail}</span>}</span>
              ) })()}
            </div>
          </div>
        )}
      </div>
      <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-500">
            <tr><th className="px-3 py-2">Received</th><th className="px-3 py-2">From</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Path</th><th className="px-3 py-2">Outcome</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-400">No messages yet. Use the replay form above, or connect the mailbox.</td></tr>}
            {rows.map(r => { const b = outcomeBadge(r.outcome); const d = draftByMessage.get(r.id); const isOpen = openDraft === r.id; return (
              <Fragment key={r.id}>
              <tr className={`border-t border-gray-100 align-top ${d ? 'cursor-pointer hover:bg-gray-50' : ''}`} onClick={() => d && setOpenDraft(isOpen ? null : r.id)}>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmt(r.received_at)}</td>
                <td className="px-3 py-2 text-gray-900">{r.from_name ? <>{r.from_name}<br /><span className="text-xs text-gray-500">{r.from_addr}</span></> : r.from_addr}</td>
                <td className="px-3 py-2 text-gray-900 max-w-md"><div className="truncate">{r.subject ?? '—'}</div>{r.snippet && <div className="text-xs text-gray-500 truncate">{r.snippet}</div>}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{r.delivery_path ?? '—'}</td>
                <td className="px-3 py-2">
                  <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${b.cls}`}>{b.label}</span>
                  {d && d.unsourced_claims.length > 0 && <span className="ml-1 inline-flex px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-800">{d.unsourced_claims.length} unsourced</span>}
                  {r.outcome_detail && <div className="text-xs text-gray-500 mt-0.5 max-w-xs">{r.outcome_detail}</div>}
                  {d && <div className="text-[11px] text-gray-400 mt-0.5">{isOpen ? 'click to hide draft' : 'click to view draft'}</div>}
                </td>
              </tr>
              {d && isOpen && (
                <tr className="bg-gray-50"><td colSpan={5} className="px-4 py-3"><DraftDetail d={d} /></td></tr>
              )}
              </Fragment>
            ) })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const REASON_LABEL: Record<string, string> = {
  ungrounded: 'contains unsourced claims', multi_match: 'more than one job matched', no_match: 'no job matched', refresh_failed: 'live Service Fusion read failed',
  multi_part: 'several questions in one email', asks_for_human: 'sender asked for a person', could_not_answer: 'Cassie could not answer from the facts',
  auto_off: 'Auto-Respond is off', type_not_auto: 'question type not in the auto-send focus area', tier_not_auto: 'match tier not enabled for auto-send', tier_paused: 'tier paused by confusion rate',
}

function DraftDetail({ d }: { d: DraftRow }) {
  const status = d.status === 'draft' ? { label: 'Draft — not sent', cls: 'bg-amber-100 text-amber-800' } : d.status === 'failed' ? { label: 'Failed', cls: 'bg-red-100 text-red-800' } : outcomeBadge(d.status)
  return (
    <div className="grid lg:grid-cols-2 gap-4 text-sm">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${status.cls}`}>{status.label}</span>
          {d.question_type && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">{d.question_type}</span>}
          {d.sf_job_number && <span className="text-xs text-gray-600">Job {d.sf_job_number} <span className="text-gray-400">via {d.resolve_tier}</span></span>}
          {d.resolve_status && d.resolve_status !== 'matched' && <span className="text-xs text-red-700">{d.resolve_status === 'ambiguous' ? 'ambiguous match' : 'no match'}</span>}
        </div>
        {d.question_summary && <p className="text-xs text-gray-500 mb-2">Asked: {d.question_summary}</p>}
        {d.error && <p className="text-xs text-red-700 mb-2">{d.error}</p>}
        {d.composed_text && (
          <div className="rounded border border-gray-200 bg-white p-3">
            <div className="text-xs text-gray-400 mb-1">{d.composed_subject}</div>
            <pre className="whitespace-pre-wrap font-sans text-sm text-gray-900">{d.composed_text}</pre>
          </div>
        )}
      </div>
      <div className="space-y-3">
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1">Unsourced claims {d.unsourced_claims.length === 0 ? <span className="text-green-700 font-normal">— none</span> : <span className="text-red-700">({d.unsourced_claims.length})</span>}</div>
          {d.unsourced_claims.length > 0 && <ul className="list-disc pl-5 text-xs text-red-800 space-y-0.5">{d.unsourced_claims.map((u, i) => <li key={i}>{u}</li>)}</ul>}
        </div>
        {d.hard_fail_reasons.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">Would not auto-send because</div>
            <ul className="list-disc pl-5 text-xs text-gray-700 space-y-0.5">{d.hard_fail_reasons.map(r => <li key={r}>{REASON_LABEL[r] ?? r}</li>)}</ul>
          </div>
        )}
        {Array.isArray(d.claims) && d.claims.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">Sentence by sentence</div>
            <ul className="space-y-1">
              {d.claims.map((c, i) => (
                <li key={i} className={`text-xs rounded px-2 py-1 ${c.grounded ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-900'}`}>
                  {c.text.trim()} <span className="text-[10px] text-gray-500">{c.factIds.length ? c.factIds.join(', ') : 'no facts cited'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsTab({ settings: s, gmailConfigured, gmail, gmailFlash }: { settings: AgentSettings; gmailConfigured: boolean; gmail: GmailStatus; gmailFlash: { ok: boolean; msg: string } | null }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [f, setF] = useState({
    mailbox_address: s.mailbox_address, from_display_name: s.from_display_name, reply_to_email: s.reply_to_email ?? '',
    cc_office: s.cc_office, signature_text: s.signature_text, escape_hatch_text: s.escape_hatch_text,
    allowlist_domains: lines(s.allowlist_domains), allowlist_addresses: lines(s.allowlist_addresses), blocklist_addresses: lines(s.blocklist_addresses),
    escalation_extra_emails: lines(s.escalation_extra_emails),
    hold_minutes: s.hold_minutes, staleness_minutes: s.staleness_minutes, closed_window_days: s.closed_window_days,
  })
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))

  const save = () => start(async () => {
    setMsg(null)
    try {
      await saveAgentSettings({
        mailbox_address: f.mailbox_address.trim(), from_display_name: f.from_display_name.trim(),
        reply_to_email: f.reply_to_email.trim() || null, cc_office: f.cc_office,
        signature_text: f.signature_text.trim(), escape_hatch_text: f.escape_hatch_text.trim(),
        allowlist_domains: parseLines(f.allowlist_domains), allowlist_addresses: parseLines(f.allowlist_addresses),
        blocklist_addresses: parseLines(f.blocklist_addresses), escalation_extra_emails: parseLines(f.escalation_extra_emails),
        hold_minutes: Number(f.hold_minutes), staleness_minutes: Number(f.staleness_minutes), closed_window_days: Number(f.closed_window_days),
      })
      setMsg('Saved.'); router.refresh()
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
  })
  const toggle = (k: 'processing_enabled' | 'auto_respond_enabled', v: boolean) => start(async () => {
    try { await saveAgentSettings({ [k]: v }); router.refresh() } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
  })

  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-1">Mailbox connection</h2>
        {gmailFlash && <p className={`mb-2 rounded-md px-3 py-2 text-xs ${gmailFlash.ok ? 'border border-green-200 bg-green-50 text-green-800' : 'border border-red-200 bg-red-50 text-red-800'}`}>{gmailFlash.msg}</p>}
        {gmail.connected ? (
          <div className="text-sm text-gray-800">
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-green-500" /> Connected as <b>{gmail.email}</b>{gmail.source === 'env' && <span className="text-xs text-gray-500">(from environment variable)</span>}</span>
            <div className="text-xs text-gray-500 mt-1">Granted {fmt(gmail.grantedAt)} · last successful check {fmt(gmail.lastOkAt)}</div>
            {gmail.lastError && <div className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">Last error {fmt(gmail.lastErrorAt)}: {gmail.lastError}</div>}
          </div>
        ) : (
          <p className="text-sm text-gray-700">No mailbox connected. Cassie cannot read or send anything until this is done.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a href="/api/cassie/gmail/authorize" className={`${btn} ${!gmail.oauthReady ? 'pointer-events-none opacity-50' : ''}`}>{gmail.connected ? 'Reconnect Gmail' : 'Connect Gmail'}</a>
          <span className="text-xs text-gray-500">Sign in as <b>{s.mailbox_address}</b> when Google asks. Any other account is refused.</span>
        </div>
        {!gmail.oauthReady && <p className="mt-2 text-xs text-red-700">GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in Vercel.</p>}
        <details className="mt-2 text-xs text-gray-500"><summary className="cursor-pointer">One-time Google Cloud setup</summary>
          <ol className="list-decimal pl-5 mt-1 space-y-0.5">
            <li>In the Google Cloud project that owns the existing OAuth client, enable the <b>Gmail API</b>.</li>
            <li>On that OAuth client (Credentials → OAuth 2.0 Client IDs), add this authorized redirect URI: <code className="rounded bg-gray-100 px-1">{gmail.redirectUri}</code></li>
            <li>If the consent screen is in Testing mode, add {s.mailbox_address} as a test user (or publish it for the Workspace).</li>
            <li>Come back here, click Connect Gmail, and sign in as {s.mailbox_address}.</li>
          </ol>
        </details>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Switches</h2>
        {!gmailConfigured && (
          <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            No mailbox is connected yet, so these switches have no effect. Connect Gmail above first.
          </p>
        )}
        <div className="flex flex-wrap gap-6">
          <Switch label="Processing" hint="Off = Cassie reads nothing and drafts nothing (global kill switch)." on={s.processing_enabled} disabled={pending} onChange={v => toggle('processing_enabled', v)} />
          <Switch label="Auto-Respond" hint="Off = every reply is a draft for human approval. Launch state." on={s.auto_respond_enabled} disabled={pending || !s.processing_enabled} onChange={v => toggle('auto_respond_enabled', v)} />
        </div>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-1">Who Cassie answers</h2>
        <p className="text-xs text-gray-500 mb-3">Only senders on this list are processed. Everyone else is left in the office inbox for a person, with no reply and no draft. An empty list means nobody.</p>
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Allowed domains" hint="one per line, e.g. homedepot.com"><textarea rows={5} className={input} value={f.allowlist_domains} onChange={e => set('allowlist_domains', e.target.value)} /></Field>
          <Field label="Allowed addresses" hint="individual senders outside those domains"><textarea rows={5} className={input} value={f.allowlist_addresses} onChange={e => set('allowlist_addresses', e.target.value)} /></Field>
          <Field label="Blocked addresses" hint="never answered, even on an allowed domain"><textarea rows={5} className={input} value={f.blocklist_addresses} onChange={e => set('blocklist_addresses', e.target.value)} /></Field>
        </div>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Mailbox and signature</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Cassie's address"><input className={input} value={f.mailbox_address} onChange={e => set('mailbox_address', e.target.value)} /></Field>
          <Field label="From display name" hint="carries the AI disclosure before the signature does"><input className={input} value={f.from_display_name} onChange={e => set('from_display_name', e.target.value)} /></Field>
          <Field label="Reply-To" hint="blank = the office inbox from the domain config"><input className={input} value={f.reply_to_email} onChange={e => set('reply_to_email', e.target.value)} placeholder="info@castlegarage.com" /></Field>
          <label className="flex items-center gap-2 text-sm text-gray-800 mt-6"><input type="checkbox" checked={f.cc_office} onChange={e => set('cc_office', e.target.checked)} /> CC the office inbox on every reply</label>
          <Field label="Signature line"><input className={input} value={f.signature_text} onChange={e => set('signature_text', e.target.value)} /></Field>
          <Field label="Human escape hatch"><input className={input} value={f.escape_hatch_text} onChange={e => set('escape_hatch_text', e.target.value)} /></Field>
        </div>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Escalation and timing</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Extra escalation emails" hint="app users subscribe under Notifications → Cassie: Thread Escalated; add non-user inboxes here"><textarea rows={3} className={input} value={f.escalation_extra_emails} onChange={e => set('escalation_extra_emails', e.target.value)} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Hold (min)" hint="before an auto-send goes out"><input type="number" min={0} className={input} value={f.hold_minutes} onChange={e => set('hold_minutes', Number(e.target.value))} /></Field>
            <Field label="Staleness (min)" hint="max age of SF data"><input type="number" min={1} className={input} value={f.staleness_minutes} onChange={e => set('staleness_minutes', Number(e.target.value))} /></Field>
            <Field label="Closed window (days)" hint="how long a finished job stays findable"><input type="number" min={1} className={input} value={f.closed_window_days} onChange={e => set('closed_window_days', Number(e.target.value))} /></Field>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className={btn} disabled={pending} onClick={save}>Save settings</button>
        {msg && <span className={`text-sm ${msg === 'Saved.' ? 'text-green-700' : 'text-red-700'}`}>{msg}</span>}
        <span className="text-xs text-gray-400 ml-auto">Last updated {fmt(s.updated_at)}</span>
      </div>
    </div>
  )
}

function Switch({ label, hint, on, disabled, onChange }: { label: string; hint: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div>
      <button type="button" disabled={disabled} onClick={() => onChange(!on)}
        className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium border ${on ? 'bg-green-600 border-green-600 text-white' : 'bg-white border-gray-300 text-gray-700'} disabled:opacity-50`}>
        <span className={`h-2.5 w-2.5 rounded-full ${on ? 'bg-white' : 'bg-gray-400'}`} />{label}: {on ? 'On' : 'Off'}
      </button>
      <p className="text-xs text-gray-500 mt-1 max-w-xs">{hint}</p>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="block text-gray-700 font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-gray-400 mt-1">{hint}</span>}
    </label>
  )
}

// ── Charter ─────────────────────────────────────────────────────────────────

function CharterTab({ charter, versions }: { charter: Charter; versions: Charter[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [body, setBody] = useState(charter.body)
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const dirty = body !== charter.body
  return (
    <div className="space-y-4">
      <div className={card}>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Charter — version {charter.version}</h2>
            <p className="text-xs text-gray-500">Who Cassie is and how she behaves, across every channel. Included in every composition. Saving creates a new version; older versions stay for attribution.</p>
          </div>
        </div>
        <textarea className={`${input} font-mono text-xs leading-relaxed`} rows={28} value={body} onChange={e => setBody(e.target.value)} />
        <div className="mt-3 flex items-center gap-3">
          <input className={`${input} max-w-md`} placeholder="What changed? (shown in version history)" value={note} onChange={e => setNote(e.target.value)} />
          <button className={btn} disabled={pending || !dirty} onClick={() => start(async () => {
            setMsg(null)
            try { await saveCharter(body, note); setNote(''); setMsg('Saved as a new version.'); router.refresh() } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
          })}>Save new version</button>
          {dirty && <button className={btnGhost} disabled={pending} onClick={() => setBody(charter.body)}>Discard</button>}
          {msg && <span className="text-sm text-gray-600">{msg}</span>}
        </div>
      </div>
      <div className={card}>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Version history</h3>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-gray-500"><th className="py-1">Version</th><th>Note</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {versions.map(v => (
              <tr key={v.id} className="border-t border-gray-100">
                <td className="py-1.5 text-gray-900">v{v.version} {v.is_active && <span className="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800">active</span>}</td>
                <td className="text-gray-700">{v.note ?? '—'}</td>
                <td className="text-gray-500">{fmt(v.created_at)}</td>
                <td className="text-right">{!v.is_active && <button className={btnGhost} disabled={pending} onClick={() => start(async () => { await activateCharter(v.id); router.refresh() })}>Make active</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Standing instructions ───────────────────────────────────────────────────

function InstructionsTab({ rows }: { rows: Instruction[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [text, setText] = useState('')
  const [channel, setChannel] = useState<'all' | 'email' | 'phone'>('all')
  const [showRetired, setShowRetired] = useState(false)
  const active = rows.filter(r => r.is_active), retired = rows.filter(r => !r.is_active)
  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-1">Add an instruction</h2>
        <p className="text-xs text-gray-500 mb-3">Plain English rules applied to every reply from now on. Examples: &ldquo;Always give the arrival window, not just the date.&rdquo; &ldquo;Never say &lsquo;unfortunately&rsquo;.&rdquo; &ldquo;For Clopay reps, lead with the PO number.&rdquo; Each draft shows which instructions it applied.</p>
        <div className="flex gap-3 items-start">
          <textarea rows={2} className={input} value={text} onChange={e => setText(e.target.value)} placeholder="Write the rule as you would tell a new hire." />
          <select className={`${input} w-32`} value={channel} onChange={e => setChannel(e.target.value as 'all' | 'email' | 'phone')}>
            <option value="all">All channels</option><option value="email">Email only</option><option value="phone">Phone only</option>
          </select>
          <button className={btn} disabled={pending || !text.trim()} onClick={() => start(async () => { await createInstruction(text, channel); setText(''); router.refresh() })}>Add</button>
        </div>
      </div>
      <div className={card}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900">Active ({active.length})</h3>
          {retired.length > 0 && <button className="text-xs text-gray-500 underline" onClick={() => setShowRetired(v => !v)}>{showRetired ? 'Hide' : 'Show'} retired ({retired.length})</button>}
        </div>
        {active.length === 0 && <p className="text-sm text-gray-400">None yet.</p>}
        <ul className="divide-y divide-gray-100">
          {active.map(r => (
            <li key={r.id} className="py-2 flex items-start gap-3">
              <span className="flex-1 text-sm text-gray-900">{r.text}</span>
              <span className="text-[10px] uppercase tracking-wide text-gray-400 mt-1">{r.channel}</span>
              <button className={btnGhost} disabled={pending} onClick={() => start(async () => { await retireInstructionAction(r.id); router.refresh() })}>Retire</button>
            </li>
          ))}
        </ul>
        {showRetired && retired.map(r => (
          <div key={r.id} className="py-2 flex items-start gap-3 border-t border-gray-100 opacity-60">
            <span className="flex-1 text-sm text-gray-700 line-through">{r.text}</span>
            <span className="text-xs text-gray-400">retired {fmt(r.retired_at)}</span>
            <button className={btnGhost} disabled={pending} onClick={() => start(async () => { await reactivateInstructionAction(r.id); router.refresh() })}>Reactivate</button>
          </div>
        ))}
      </div>
      {active.length >= 12 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">You have {active.length} active instructions. Worth a periodic read-through — instructions accumulate and start to contradict each other.</p>
      )}
    </div>
  )
}

// ── Answer library ──────────────────────────────────────────────────────────

const emptyAnswer = { title: '', question_examples: '', question_type: '', answer_text: '', audience: 'partner' }

function AnswersTab({ rows }: { rows: AnswerEntry[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [editing, setEditing] = useState<string | null | 'new'>(null)
  const [f, setF] = useState(emptyAnswer)
  const [showInactive, setShowInactive] = useState(false)
  const open = (a: AnswerEntry | null) => {
    setEditing(a ? a.id : 'new')
    setF(a ? { title: a.title, question_examples: lines(a.question_examples), question_type: a.question_type ?? '', answer_text: a.answer_text, audience: a.audience } : emptyAnswer)
  }
  const visible = rows.filter(r => showInactive || r.is_active)
  return (
    <div className="space-y-4">
      <div className={card}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Curated answers</h2>
            <p className="text-xs text-gray-500">Fixed correct answers to recurring questions Service Fusion cannot answer — lead times, what Castle handles versus Home Depot, permits. Write it once here and Cassie can use it. These count as grounded facts, so keep them accurate.</p>
          </div>
          <button className={btn} onClick={() => open(null)}>New answer</button>
        </div>
      </div>
      {editing && (
        <div className={`${card} border-gray-400`}>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Title"><input className={input} value={f.title} onChange={e => setF(x => ({ ...x, title: e.target.value }))} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Question type"><select className={input} value={f.question_type} onChange={e => setF(x => ({ ...x, question_type: e.target.value }))}>{QUESTION_TYPES.map(q => <option key={q.value} value={q.value}>{q.label}</option>)}</select></Field>
              <Field label="Audience"><select className={input} value={f.audience} onChange={e => setF(x => ({ ...x, audience: e.target.value }))}><option value="partner">Partners</option><option value="customer">Customers</option><option value="all">Both</option></select></Field>
            </div>
            <Field label="Ways people ask it" hint="one per line — helps Cassie recognise the question"><textarea rows={4} className={input} value={f.question_examples} onChange={e => setF(x => ({ ...x, question_examples: e.target.value }))} /></Field>
            <Field label="The answer" hint="written the way Cassie should say it"><textarea rows={4} className={input} value={f.answer_text} onChange={e => setF(x => ({ ...x, answer_text: e.target.value }))} /></Field>
          </div>
          <div className="mt-3 flex gap-2">
            <button className={btn} disabled={pending || !f.title.trim() || !f.answer_text.trim()} onClick={() => start(async () => {
              await saveAnswer(editing === 'new' ? null : editing, { title: f.title, question_examples: parseLines(f.question_examples), question_type: f.question_type || null, answer_text: f.answer_text, audience: f.audience })
              setEditing(null); router.refresh()
            })}>Save</button>
            <button className={btnGhost} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className={card}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900">{visible.length} entr{visible.length === 1 ? 'y' : 'ies'}</h3>
          <label className="text-xs text-gray-500 flex items-center gap-1"><input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> show inactive</label>
        </div>
        {visible.length === 0 && <p className="text-sm text-gray-400">Nothing here yet. Questions Cassie cannot ground will start showing up in the coverage log, and each Google Chat answer can be promoted here with one tap.</p>}
        <ul className="divide-y divide-gray-100">
          {visible.map(a => (
            <li key={a.id} className={`py-3 ${a.is_active ? '' : 'opacity-60'}`}>
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900">{a.title} {a.question_type && <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">{a.question_type}</span>} <span className="ml-1 text-[10px] uppercase tracking-wide text-gray-400">{a.audience}</span></div>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap mt-1">{a.answer_text}</p>
                  {a.question_examples.length > 0 && <p className="text-xs text-gray-400 mt-1">Asked as: {a.question_examples.join(' · ')}</p>}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button className={btnGhost} onClick={() => open(a)}>Edit</button>
                  <button className={btnGhost} disabled={pending} onClick={() => start(async () => { await setAnswerActiveAction(a.id, !a.is_active); router.refresh() })}>{a.is_active ? 'Deactivate' : 'Activate'}</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ── Style corpus ────────────────────────────────────────────────────────────

function StyleTab({ rows }: { rows: StyleExample[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [f, setF] = useState({ inquiry_text: '', final_text: '', question_type: '' })
  const SOURCE: Record<string, string> = { seed: 'Cassie spec', staff: 'Staff email', human_edit: 'Edited draft', human_approved: 'Approved draft' }
  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-1">Add a real staff reply</h2>
        <p className="text-xs text-gray-500 mb-3">Paste 20–30 real replies your team has sent to Home Depot and Clopay. This is how Cassie learns Castle&apos;s actual voice. Every draft a person edits or approves is added here automatically later.</p>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="What the partner asked" hint="optional"><textarea rows={4} className={input} value={f.inquiry_text} onChange={e => setF(x => ({ ...x, inquiry_text: e.target.value }))} /></Field>
          <Field label="What we replied"><textarea rows={4} className={input} value={f.final_text} onChange={e => setF(x => ({ ...x, final_text: e.target.value }))} /></Field>
        </div>
        <div className="mt-3 flex gap-3 items-center">
          <select className={`${input} w-48`} value={f.question_type} onChange={e => setF(x => ({ ...x, question_type: e.target.value }))}>{QUESTION_TYPES.map(q => <option key={q.value} value={q.value}>{q.label}</option>)}</select>
          <button className={btn} disabled={pending || !f.final_text.trim()} onClick={() => start(async () => { await createStyleExample(f); setF({ inquiry_text: '', final_text: '', question_type: '' }); router.refresh() })}>Add example</button>
        </div>
      </div>
      <div className={card}>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">{rows.length} example{rows.length === 1 ? '' : 's'} <span className="text-xs text-gray-400 font-normal">— pinned ones are always included; others are retrieved by similarity</span></h3>
        <ul className="divide-y divide-gray-100">
          {rows.map(r => (
            <li key={r.id} className="py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">{SOURCE[r.source] ?? r.source}{r.question_type ? ` · ${r.question_type}` : ''}{r.is_pinned ? ' · pinned' : ''}</div>
                {r.inquiry_text && <p className="text-xs text-gray-500 italic mb-1">&ldquo;{r.inquiry_text}&rdquo;</p>}
                {r.ai_text && r.ai_text !== r.final_text && <p className="text-xs text-red-700/70 line-through mb-1">{r.ai_text}</p>}
                <p className="text-sm text-gray-900 whitespace-pre-wrap">{r.final_text}</p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button className={btnGhost} disabled={pending} onClick={() => start(async () => { await pinStyleExample(r.id, !r.is_pinned); router.refresh() })}>{r.is_pinned ? 'Unpin' : 'Pin'}</button>
                <button className={btnGhost} disabled={pending} onClick={() => { if (confirm('Remove this example from the corpus?')) start(async () => { await removeStyleExample(r.id); router.refresh() }) }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
