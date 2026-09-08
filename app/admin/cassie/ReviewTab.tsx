'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ReviewItem } from '@/lib/agent/email/review'
import { approveReplyAction, rejectReplyAction, escalateReplyAction, replyFeedbackAction, unqueueReplyAction, saveAsRegressionCase, deleteReplayAction, reviseReplyAction, type ActionResult } from './actions'
import type { AgentSettings } from '@/lib/agent/settings'
import { AutoRespondSwitch } from './AutoSendControls'

// Review panel (PRD §12). Rules this UI enforces on purpose:
//  • Every item carries an unambiguous state label with distinct colour: a draft can
//    never be mistaken for a sent reply.
//  • The queue is sorted by confidence, highest first, so the best drafts come first.
//  • Nothing leaves the queue without an explicit choice: approve, reject or escalate.
//  • The unsourced-claim list is the first thing on the right, in red, never collapsed.

const input = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 bg-white'
const btn = 'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50'
const btnGhost = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const btnDanger = 'rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50'

const fmt = (s: string | null | undefined) => {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const STATE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft — not sent', cls: 'bg-amber-100 text-amber-900 border border-amber-300' },
  queued: { label: 'Queued — waiting to send', cls: 'bg-purple-100 text-purple-900 border border-purple-300' },
  sent: { label: 'Sent', cls: 'bg-green-100 text-green-900 border border-green-300' },
  cancelled: { label: 'Cancelled', cls: 'bg-gray-100 text-gray-700 border border-gray-300' },
  superseded: { label: 'Superseded — a person replied', cls: 'bg-gray-100 text-gray-700 border border-gray-300' },
  rejected: { label: 'Rejected', cls: 'bg-gray-200 text-gray-700 border border-gray-300' },
  escalated: { label: 'Escalated to a person', cls: 'bg-blue-100 text-blue-900 border border-blue-300' },
  failed: { label: 'Failed', cls: 'bg-red-100 text-red-900 border border-red-300' },
}
export const StateBadge = ({ status }: { status: string }) => {
  const s = STATE[status] ?? { label: status, cls: 'bg-gray-100 text-gray-700' }
  return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${s.cls}`}>{s.label}</span>
}

export const REASON_LABEL: Record<string, string> = {
  ungrounded: 'contains unsourced claims', multi_match: 'more than one job matched', no_match: 'no job matched', refresh_failed: 'live Service Fusion read failed',
  multi_part: 'several questions in one email', asks_for_human: 'sender asked for a person', could_not_answer: 'Cassie could not answer from the facts',
  auto_off: 'Auto-Respond is off', type_not_auto: 'question type not in the auto-send focus area', tier_not_auto: 'match tier not enabled for auto-send',
  tier_paused: 'tier paused by confusion rate', below_threshold: 'confidence below the threshold', chat_sourced: 'written from a team answer in Google Chat (needs a person to approve)',
  reviewer_sourced: 'revised from a reviewer\'s instruction (needs a person to approve)',
}

const SOURCE_LABEL: Record<string, string> = {
  sf_job: 'Service Fusion job', vendor_order: 'Vendor order', answer_library: 'Answer library', instruction: 'Standing instruction', style_example: 'Style example',
  charter: 'Charter', thread_message: 'Thread message', chat_answer: 'Google Chat answer', reviewer_note: 'Reviewer\'s instruction', model: 'Model', resolver: 'Job match', inquiry: 'The partner\'s own message',
}

type View = 'queue' | 'followups' | 'queued' | 'sent' | 'closed'

export default function ReviewTab({ items, gmailConfigured, initialOpen, settings, autoBaselineOk }: { items: ReviewItem[]; gmailConfigured: boolean; initialOpen: string | null; settings: AgentSettings; autoBaselineOk: boolean }) {
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>('queue')
  const [openId, setOpenId] = useState<string | null>(initialOpen)
  const byView: Record<View, ReviewItem[]> = {
    queue: items.filter(i => i.status === 'draft'),
    queued: items.filter(i => i.status === 'queued'),
    followups: items.filter(i => i.outcomes.some(o => o.classification !== 'resolved')),
    sent: items.filter(i => i.status === 'sent'),
    closed: items.filter(i => ['rejected', 'escalated', 'cancelled', 'superseded', 'failed'].includes(i.status)),
  }
  const needle = q.trim().toLowerCase()
  const matches = (i: ReviewItem) => !needle || [i.message?.subject, i.message?.from_addr, i.message?.from_name, i.sf_job_number, i.question_summary, i.sent_text, i.composed_text, i.message?.body_text].some(v => (v ?? '').toLowerCase().includes(needle))
  const list = byView[view].filter(matches)
  return (
    <div className="space-y-4">
      <AutoRespondSwitch settings={settings} canEnable={gmailConfigured && settings.processing_enabled && autoBaselineOk} baselineOk={autoBaselineOk} />
      {!gmailConfigured && byView.queued.length > 0 && (
        <p className="rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-900">{byView.queued.length} approved repl{byView.queued.length === 1 ? 'y is' : 'ies are'} queued but no mailbox is connected yet, so nothing has been sent. They will go out once Gmail is connected under Settings.</p>
      )}
      <div className="flex gap-1 text-sm">
        {([['queue', 'Needs review'], ['followups', 'Follow-ups'], ['queued', 'Queued'], ['sent', 'Sent'], ['closed', 'Closed']] as [View, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setView(k)} className={`px-3 py-1.5 rounded-full border ${view === k ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}>
            {label} <span className={`ml-1 text-xs ${view === k ? 'text-gray-300' : 'text-gray-400'}`}>{byView[k].length}</span>
          </button>
        ))}
      </div>
      {(view === 'sent' || view === 'closed' || view === 'followups') && (
        <input className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-900 bg-white" placeholder="Search by subject, sender, job number, or any words in the email or reply" value={q} onChange={e => setQ(e.target.value)} />
      )}
      {list.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          {view === 'queue' ? 'Nothing waiting for review.' : view === 'followups' ? 'No partner has come back confused or with a new question.' : 'Nothing here yet.'}
        </div>
      )}
      <div className="space-y-2">
        {list.map(item => {
          const open = openId === item.id
          const m = item.message
          return (
            <div key={item.id} className={`rounded-lg border bg-white ${open ? 'border-gray-400' : 'border-gray-200'}`}>
              <button className="w-full text-left px-4 py-3 flex items-start gap-3" onClick={() => setOpenId(open ? null : item.id)}>
                <div className="w-14 shrink-0 text-center">
                  <div className={`text-lg font-semibold ${confColor(item.confidence)}`}>{item.confidence == null ? '—' : `${Math.round(item.confidence * 100)}`}</div>
                  <div className="text-[10px] uppercase tracking-wide text-gray-400">conf.</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <StateBadge status={item.status} />
                    {item.unsourced_claims.length > 0 && <span className="inline-flex px-2 py-0.5 rounded text-xs font-semibold bg-red-600 text-white">{item.unsourced_claims.length} unsourced</span>}
                    {item.question_type && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">{item.question_type}</span>}
                    {item.sf_job_number ? <span className="text-xs text-gray-600">Job {item.sf_job_number} <span className="text-gray-400">via {item.resolve_tier}</span></span> : <span className="text-xs text-red-700">{item.resolve_status === 'ambiguous' ? 'ambiguous match' : 'no job matched'}</span>}
                    {item.was_edited && <span className="text-[10px] text-gray-500">edited</span>}
                    {item.approval_path === 'auto' && item.status === 'sent' && <span className="text-[10px] text-purple-700">auto-sent</span>}
                    {item.outcomes.map((o, i) => <OutcomeBadge key={i} c={o.classification} />)}
                  </div>
                  <div className="text-sm text-gray-900 truncate">{m?.subject ?? item.composed_subject ?? '(no subject)'}</div>
                  <div className="text-xs text-gray-500 truncate">{m?.from_name ? `${m.from_name} · ` : ''}{m?.from_addr} · {fmt(m?.received_at ?? item.created_at)}{item.question_summary ? ` · ${item.question_summary}` : ''}</div>
                </div>
              </button>
              {open && <ReviewDetail item={item} onDone={() => setOpenId(null)} onOpen={id => setOpenId(id)} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const OUTCOME: Record<string, { label: string; cls: string }> = {
  resolved: { label: 'Partner: resolved', cls: 'bg-green-100 text-green-900' },
  confused: { label: 'Partner: confused', cls: 'bg-red-600 text-white' },
  new_question: { label: 'Partner: new question', cls: 'bg-indigo-100 text-indigo-900' },
}
const OutcomeBadge = ({ c }: { c: string }) => { const o = OUTCOME[c] ?? { label: c, cls: 'bg-gray-100 text-gray-700' }; return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${o.cls}`}>{o.label}</span> }

const confColor = (c: number | null) => c == null ? 'text-gray-400' : c >= 0.9 ? 'text-green-700' : c >= 0.6 ? 'text-amber-700' : 'text-red-700'

function ReviewDetail({ item, onDone, onOpen }: { item: ReviewItem; onDone: () => void; onOpen: (id: string) => void }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [text, setText] = useState(item.sent_text ?? item.composed_text ?? '')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [showSources, setShowSources] = useState(false)
  const m = item.message
  const actionable = item.status === 'draft'
  const edited = text.trim() !== (item.composed_text ?? '').trim()
  // Actions report failure by returning { error } rather than throwing: a thrown message is
  // replaced by Next.js in production with a generic render error the reviewer cannot act on.
  const run = (fn: () => Promise<ActionResult | unknown>, opts: { done?: boolean; ok?: string; onOk?: (r: ActionResult & Record<string, unknown>) => void } = {}) => start(async () => {
    setMsg(null)
    try {
      const r = ((await fn()) ?? {}) as ActionResult & Record<string, unknown>
      if (r.error) { setMsg(r.error); return }
      router.refresh()
      opts.onOk?.(r)
      if (opts.ok) setMsg(opts.ok)
      if (opts.done ?? true) onDone()
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
  })
  const bd = item.confidence_breakdown as { match?: number; coverage?: number; grounding?: number; freshness?: number } | null

  return (
    <div className="border-t border-gray-200 px-4 py-4 grid lg:grid-cols-2 gap-5 text-sm">
      {/* Left: what they asked, what Cassie wrote */}
      <div className="space-y-3">
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1">Their email</div>
          <div className="rounded border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs text-gray-500 mb-1">{m?.from_name ? `${m.from_name} <${m.from_addr}>` : m?.from_addr} · {fmt(m?.received_at)}{m?.delivery_path ? ` · ${m.delivery_path}` : ''}</div>
            <div className="text-xs font-medium text-gray-800 mb-1">{m?.subject}</div>
            <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 max-h-64 overflow-auto">{m?.body_text ?? ''}</pre>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-semibold text-gray-700">{actionable ? 'Cassie’s draft — edit freely before approving' : 'Reply text'}</div>
            <div className="text-xs text-gray-400">{item.composed_subject}</div>
          </div>
          {actionable
            ? <textarea className={`${input} font-sans leading-relaxed`} rows={Math.min(22, Math.max(8, text.split('\n').length + 2))} value={text} onChange={e => setText(e.target.value)} />
            : <pre className="rounded border border-gray-200 bg-white p-3 whitespace-pre-wrap font-sans text-sm text-gray-900">{item.sent_text ?? item.composed_text}</pre>}
          {actionable && edited && <div className="text-xs text-amber-700 mt-1">Edited — both versions will be saved to the style corpus so Cassie learns from the change.</div>}
          {item.status !== 'draft' && item.was_edited && item.composed_text && (
            <details className="mt-2 text-xs"><summary className="cursor-pointer text-gray-500">Show Cassie’s original before edits</summary><pre className="mt-1 whitespace-pre-wrap font-sans text-gray-600 rounded bg-gray-50 p-2">{item.composed_text}</pre></details>
          )}
        </div>
        {actionable && (
          <div className="space-y-2">
            <input className={input} placeholder="Optional note — “too formal”, “don’t promise dates”, “the PO is probably 74491444, look that up”. Travels with this example." value={note} onChange={e => setNote(e.target.value)} />
            <div className="flex flex-wrap gap-2 items-center">
              <button className={btnGhost} disabled={pending || !note.trim()} title="Cassie writes the draft again from your note. The note is kept as feedback; the new draft still needs your approval."
                onClick={() => run(() => reviseReplyAction(item.id, note), { done: false, onOk: r => { if (typeof r.replyId === 'string') onOpen(r.replyId) } })}>Revise with this</button>
              <span className="text-gray-300">|</span>
              <button className={btn} disabled={pending || !text.trim() || item.unsourced_claims.length > 0 && !edited} onClick={() => run(() => approveReplyAction(item.id, text, note))}>{edited ? 'Approve edited version' : 'Approve'}</button>
              <button className={btnGhost} disabled={pending} onClick={() => run(() => escalateReplyAction(item.id, note))}>Escalate to a person</button>
              <button className={btnDanger} disabled={pending} onClick={() => run(() => rejectReplyAction(item.id, note))}>Reject</button>
              {item.unsourced_claims.length > 0 && !edited && <span className="text-xs text-red-700">Approve is disabled until the unsourced claims are edited out.</span>}
            </div>
          </div>
        )}
        {item.status === 'queued' && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-600">Approved {fmt(item.send_after)}{item.approval_path ? ` (${item.approval_path})` : ''}. Waiting for the sender.</span>
            <button className={btnGhost} disabled={pending} onClick={() => run(() => unqueueReplyAction(item.id))}>Un-queue</button>
          </div>
        )}
        {item.status === 'sent' && item.approval_path !== 'auto' && (
          <div className="flex items-center gap-2">
            <button className={btnGhost} disabled={pending} onClick={() => run(() => saveAsRegressionCase(item.id), { done: false, ok: 'Saved as a regression test case (Dashboard → Regression set).' })}>Save as test case</button>
            <span className="text-xs text-gray-500">Freezes this inquiry, the job facts, and the reply a person approved as a known-good example.</span>
          </div>
        )}
        {m?.delivery_path === 'replay' && (
          <div className="flex items-center gap-3">
            <button className={btnDanger} disabled={pending} onClick={() => { if (confirm('Delete this replayed email and everything Cassie composed from it?')) run(() => deleteReplayAction(item.message_id)) }}>Delete replay</button>
            <span className="text-xs text-gray-500">This was pasted in as a test. Real partner emails cannot be deleted — close them with Reject or Escalate.</span>
          </div>
        )}
        {['sent', 'rejected', 'escalated', 'cancelled', 'superseded'].includes(item.status) && (
          <div className="flex gap-2">
            <input className={input} placeholder="Add a note about this reply (kept with it for review)" value={note} onChange={e => setNote(e.target.value)} />
            <button className={btnGhost} disabled={pending || !note.trim()} onClick={() => run(() => replyFeedbackAction(item.id, item.status === 'sent' ? 'post_send' : 'note', note), { done: false, ok: 'Note saved.', onOk: () => setNote('') })}>Save note</button>
          </div>
        )}
        {msg && <p className={`text-sm ${/^Saved/.test(msg) ? 'text-green-700' : 'text-red-700'}`}>{msg}</p>}
        {item.error && <p className="text-xs text-red-700">{item.error}</p>}
      </div>

      {/* Right: grounding, reasons, sources */}
      <div className="space-y-3">
        <div className={`rounded border p-3 ${item.unsourced_claims.length ? 'border-red-300 bg-red-50' : 'border-green-200 bg-green-50'}`}>
          <div className={`text-xs font-semibold mb-1 ${item.unsourced_claims.length ? 'text-red-900' : 'text-green-900'}`}>
            Unsourced claims {item.unsourced_claims.length === 0 ? '— none. Every concrete statement traces to a record.' : `(${item.unsourced_claims.length}) — Cassie asserted these on her own authority`}
          </div>
          {item.unsourced_claims.length > 0 && <ul className="list-disc pl-5 text-xs text-red-900 space-y-0.5">{item.unsourced_claims.map((u, i) => <li key={i}>{u}</li>)}</ul>}
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1">Confidence {item.confidence != null && <span className={`${confColor(item.confidence)}`}>{Math.round(item.confidence * 100)}%</span>}</div>
          {bd && <div className="grid grid-cols-4 gap-1 text-[11px] text-gray-600">
            {(['match', 'coverage', 'grounding', 'freshness'] as const).map(k => <div key={k} className="rounded bg-gray-50 px-2 py-1"><div className="uppercase tracking-wide text-[9px] text-gray-400">{k}</div><div className="font-medium text-gray-800">{bd[k] == null ? '—' : Math.round((bd[k] as number) * 100)}%</div></div>)}
          </div>}
          {(item.hard_fail_reasons.length > 0 || (item.auto_send_blockers ?? []).length > 0) && (
            <ul className="mt-2 list-disc pl-5 text-xs text-gray-700 space-y-0.5">
              <li className="list-none -ml-5 text-[11px] uppercase tracking-wide text-gray-400">{item.approval_path === 'auto' ? 'Auto-sent — checks at compose time' : 'Would not auto-send because'}</li>
              {[...new Set([...item.hard_fail_reasons, ...(item.auto_send_blockers ?? [])])].map(r => <li key={r}>{REASON_LABEL[r] ?? r}</li>)}
            </ul>
          )}
          {item.approval_path === 'auto' && item.status === 'queued' && <p className="mt-1 text-xs text-purple-800">Auto-approved. Sends {fmt(item.send_after)} unless a person replies first or the job changes.</p>}
        </div>
        {Array.isArray(item.claims) && item.claims.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">Sentence by sentence</div>
            <ul className="space-y-1">{item.claims.map((c, i) => (
              <li key={i} className={`text-xs rounded px-2 py-1 ${c.grounded ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-900'}`}>{c.text.trim()} <span className="text-[10px] text-gray-500">{c.factIds.length ? c.factIds.join(', ') : 'no facts cited'}</span></li>
            ))}</ul>
          </div>
        )}
        <div>
          <button className="text-xs text-gray-600 underline" onClick={() => setShowSources(v => !v)}>{showSources ? 'Hide' : 'Show'} sources ({item.sources.length})</button>
          {showSources && (
            <ul className="mt-1 divide-y divide-gray-100 rounded border border-gray-200 bg-white">
              {[...item.sources].sort((a, b) => a.source_type.localeCompare(b.source_type)).map((s, i) => (
                <li key={i} className="px-2 py-1.5 text-xs">
                  <span className="text-gray-400">{SOURCE_LABEL[s.source_type] ?? s.source_type}</span> <span className="text-gray-800">{s.ref_label ?? s.ref_id}</span>
                  {s.source_type === 'sf_job' && s.fields && 'text' in s.fields && <div className="text-gray-600">{String(s.fields.text)}</div>}
                  {s.source_type === 'answer_library' && s.fields && 'answer_text' in s.fields && <div className="text-gray-600">{String(s.fields.answer_text)}</div>}
                </li>
              ))}
              <li className="px-2 py-1.5 text-[11px] text-gray-400">Charter v{item.charter_version ?? '?'} · {item.model ?? 'model unknown'} · live read {fmt(item.live_fetched_at)}</li>
            </ul>
          )}
        </div>
        {item.outcomes.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">What the partner did next</div>
            <ul className="space-y-2">{item.outcomes.map((o, i) => (
              <li key={i} className="rounded border border-gray-200 bg-white p-2">
                <div className="flex items-center gap-2 mb-1"><OutcomeBadge c={o.classification} /><span className="text-[11px] text-gray-500">{fmt(o.created_at)}</span></div>
                {o.reason && <div className="text-xs text-gray-600 italic mb-1">{o.reason}</div>}
                {o.partner_text && <pre className="whitespace-pre-wrap font-sans text-xs text-gray-800 max-h-40 overflow-auto">{o.partner_text.split(/\nOn .{5,120} wrote:/)[0].split('\n').filter(l => !l.startsWith('>')).join('\n').trim()}</pre>}
                {o.classification !== 'resolved' && <p className="mt-1 text-[11px] text-red-800">Cassie will not reply again in this thread. Answer from the office inbox, then add a note here about what should have been said.</p>}
              </li>
            ))}</ul>
          </div>
        )}
        {item.feedback.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">Notes</div>
            <ul className="space-y-1">{item.feedback.map((f, i) => <li key={i} className="text-xs text-gray-700"><span className="text-gray-400">{f.kind} · {fmt(f.created_at)}</span> {f.note}</li>)}</ul>
          </div>
        )}
      </div>
    </div>
  )
}
