'use client'

import { useState, useTransition } from 'react'
import { approveReplyAction, skipReplyAction, redraftReplyAction, draftNowAction } from './reputation-actions'

// The reply section of a review's detail modal (PRD §4.2 step 5, §9.1). One
// component, one state per reply status: no draft → Draft now; draft → editable
// text with Approve / Edit & approve / Skip / Redraft; scheduled → what will go
// out and when; posted / verified / skipped / failed → read-only record.

export interface ReplyInfo {
  id: string
  status: 'draft' | 'approved' | 'scheduled' | 'posted' | 'verified' | 'skipped' | 'failed'
  origin: 'new' | 'backlog'
  band: 'positive' | 'negative'
  draft_text: string
  final_text: string | null
  scheduled_for: string | null
  sent_at: string | null
  push_reasons: string[]
  guardrail_notes: { passed?: boolean; failures?: Array<{ check: string; detail: string }>; model_notes?: string | null; attempts?: number } | null
  error: string | null
  approved_by: string | null
  approved_at: string | null
}

interface Props {
  reviewId: string
  reply: ReplyInfo | null
  /** The reply currently on Google, if any (manual or pre-existing). */
  replyOnGoogle: string | null
  replySource: string | null
  onChanged: () => void
}

const fmtPt = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const PUSH_LABEL: Record<string, string> = { window: 'outside working hours', cap: 'daily cap reached', spacing: 'spaced from another send', gap_hour: 'skipped hour', retry: 'retry after a failed send' }
const btn = 'text-sm px-3 py-1.5 rounded border disabled:opacity-50'

export const REPLY_STATUS_LABEL: Record<ReplyInfo['status'], { label: string; cls: string }> = {
  draft: { label: 'Needs approval', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  approved: { label: 'Approved', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  scheduled: { label: 'Scheduled', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  posted: { label: 'Posted', cls: 'bg-green-50 text-green-700 border-green-200' },
  verified: { label: 'Verified', cls: 'bg-green-50 text-green-700 border-green-200' },
  skipped: { label: 'Skipped', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
  failed: { label: 'Failed', cls: 'bg-red-50 text-red-700 border-red-200' },
}

export function ReplyStatusPill({ reply, replyOnGoogle, replySource }: { reply: ReplyInfo | null; replyOnGoogle: string | null; replySource: string | null }) {
  if (reply && reply.status !== 'skipped') {
    const s = REPLY_STATUS_LABEL[reply.status]
    const extra = reply.status === 'scheduled' && reply.scheduled_for ? ` ${fmtPt(reply.scheduled_for)}` : ''
    return <span className={`inline-block text-xs px-2 py-0.5 rounded border whitespace-nowrap ${s.cls}`}>{s.label}{extra}</span>
  }
  if (replyOnGoogle) return <span className="inline-block text-xs px-2 py-0.5 rounded border bg-green-50 text-green-700 border-green-200 whitespace-nowrap">Replied{replySource === 'manual' || replySource === 'pre_existing' ? ' (on Google)' : ''}</span>
  if (reply?.status === 'skipped') return <span className={`inline-block text-xs px-2 py-0.5 rounded border ${REPLY_STATUS_LABEL.skipped.cls}`}>Skipped</span>
  return <span className="text-xs text-gray-300">—</span>
}

export default function ReplyPanel({ reviewId, reply, replyOnGoogle, replySource, onChanged }: Props) {
  const [pending, start] = useTransition()
  const [text, setText] = useState(reply?.draft_text ?? '')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const run = (fn: () => Promise<{ error?: string } & Record<string, unknown>>, done?: (r: Record<string, unknown>) => void) => start(async () => {
    setErr(null); setMsg(null)
    const r = await fn()
    if (r.error) { setErr(r.error); return }
    done?.(r); onChanged()
  })

  const header = <p className="text-xs text-gray-500 mb-1">Reply</p>

  if (!reply || reply.status === 'skipped') {
    if (replyOnGoogle) {
      return (
        <div className="border-t border-gray-100 pt-3">{header}
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{replyOnGoogle}</p>
          <p className="text-xs text-gray-400 mt-1">{replySource === 'agent' ? 'Sent by the reply agent.' : 'Replied on Google directly.'}</p>
        </div>
      )
    }
    return (
      <div className="border-t border-gray-100 pt-3">{header}
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-400 italic">{reply?.status === 'skipped' ? 'Reply was skipped.' : 'No draft yet.'}</p>
          <button disabled={pending} className={`${btn} border-gray-300 text-gray-700 hover:bg-gray-50`} onClick={() => run(() => draftNowAction(reviewId), r => setMsg(r.scheduled ? 'Drafted and scheduled (autopilot).' : 'Drafted.'))}>{pending ? 'Drafting…' : 'Draft now'}</button>
        </div>
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        {msg && <p className="text-xs text-green-600 mt-1">{msg}</p>}
      </div>
    )
  }

  const notes = reply.guardrail_notes
  const chips = (
    <div className="flex flex-wrap gap-1.5 mb-2">
      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{reply.band === 'positive' ? '4–5 star band' : '1–3 star band'}</span>
      {reply.origin === 'backlog' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">backlog</span>}
      {reply.approved_at && reply.approved_by === null && <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">autopilot</span>}
    </div>
  )

  if (reply.status === 'draft' || reply.status === 'failed') {
    const edited = text.trim() !== reply.draft_text.trim()
    return (
      <div className="border-t border-gray-100 pt-3">{header}{chips}
        {reply.status === 'failed' && reply.error && <p className="text-xs text-red-600 mb-2">Last attempt failed: {reply.error}</p>}
        {notes && notes.passed === false && (
          <div className="text-xs bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-2 text-amber-800">
            <b>Did not pass every check</b>{notes.attempts ? ` after ${notes.attempts} tries` : ''}. Fix before approving:
            <ul className="list-disc ml-4 mt-0.5">{(notes.failures ?? []).map((f, i) => <li key={i}>{f.detail}</li>)}</ul>
          </div>
        )}
        {notes?.model_notes && <p className="text-xs text-gray-500 mb-2">Note from the drafter: {notes.model_notes}</p>}
        <textarea value={text} onChange={e => setText(e.target.value)} rows={7} className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 text-gray-900 leading-relaxed" />
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <button disabled={pending || !text.trim()} className={`${btn} border-green-300 text-green-700 hover:bg-green-50`} onClick={() => run(() => approveReplyAction(reply.id, text), r => setMsg(`Scheduled for ${fmtPt(r.scheduledFor as string)}.`))}>{edited ? 'Edit & approve' : 'Approve'}</button>
          <button disabled={pending} className={`${btn} border-gray-300 text-gray-500 hover:bg-gray-50`} onClick={() => run(() => skipReplyAction(reply.id))}>Skip</button>
          <button disabled={pending} className={`${btn} border-blue-300 text-blue-600 hover:bg-blue-50`} onClick={() => run(() => redraftReplyAction(reply.id, note), r => { setText(r.text as string); setNote(''); setMsg('Redrafted.') })}>Redraft</button>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note for the redraft (e.g. mention the gate)" className="flex-1 min-w-[180px] text-sm border border-gray-300 rounded-md px-2 py-1.5 text-gray-900" />
        </div>
        {pending && <p className="text-xs text-gray-400 mt-1">Working…</p>}
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        {msg && <p className="text-xs text-green-600 mt-1">{msg}</p>}
      </div>
    )
  }

  if (reply.status === 'approved' || reply.status === 'scheduled') {
    return (
      <div className="border-t border-gray-100 pt-3">{header}{chips}
        <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded px-2 py-1.5">{reply.final_text}</p>
        <p className="text-xs text-gray-500 mt-1.5">Scheduled for <b>{fmtPt(reply.scheduled_for)}</b>{reply.push_reasons?.length ? ` · pushed: ${reply.push_reasons.map(p => PUSH_LABEL[p] ?? p).join(', ')}` : ''}</p>
        <div className="mt-2"><button disabled={pending} className={`${btn} border-gray-300 text-gray-500 hover:bg-gray-50`} onClick={() => run(() => skipReplyAction(reply.id))}>Cancel & skip</button></div>
        {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
      </div>
    )
  }

  return (
    <div className="border-t border-gray-100 pt-3">{header}{chips}
      <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded px-2 py-1.5">{reply.final_text ?? reply.draft_text}</p>
      <p className="text-xs text-gray-500 mt-1.5">
        {reply.status === 'verified' ? `Posted ${fmtPt(reply.sent_at)} and verified on Google.` : `Posted ${fmtPt(reply.sent_at)}; verification happens on the next sync.`}
        {reply.error && <span className="text-amber-700"> {reply.error}</span>}
      </p>
    </div>
  )
}
