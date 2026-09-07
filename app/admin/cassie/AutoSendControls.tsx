'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AgentSettings, QuestionType, MatchTier } from '@/lib/agent/settings'
import type { ReviewItem } from '@/lib/agent/email/review'
import { estimateAutoShare } from '@/lib/agent/email/routing'
import { saveAgentSettings } from './actions'
import { REASON_LABEL } from './ReviewTab'

// Auto-send controls (PRD §6.3, §12 Settings). Two placements share this code:
//   • compact — the one-click Auto-Respond switch at the top of the Review queue
//   • full    — the Settings card: threshold slider with a live "would have auto-sent"
//               estimate over recent drafts, focus-area toggles, match-tier toggles.
// The estimate is computed from the same routing function the pipeline uses.

const btn = 'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50'
const card = 'rounded-lg border border-gray-200 bg-white p-4'

const FOCUS: { key: QuestionType; label: string; hint: string }[] = [
  { key: 'schedule', label: 'Is it scheduled, and for when?', hint: 'date + arrival window' },
  { key: 'completion', label: 'Has it been completed, and when?', hint: 'completion date' },
  { key: 'tech', label: 'Which technician is assigned?', hint: 'names from the job' },
  { key: 'status', label: 'What is the current job status?', hint: 'status + sub-status' },
]
const TIERS: { key: MatchTier; label: string; hint: string }[] = [
  { key: 'po', label: 'PO / order number → exactly one job', hint: 'the only unambiguous identifier partners give' },
  { key: 'name', label: 'Customer name → exactly one active or recent job', hint: 'weaker; enable after PO sends prove clean' },
]

export function AutoRespondSwitch({ settings, canEnable }: { settings: AgentSettings; canEnable: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  const on = settings.auto_respond_enabled
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${on ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white'}`}>
      <button type="button" disabled={pending || (!on && !canEnable)} onClick={() => start(async () => {
        setErr(null)
        try { await saveAgentSettings({ auto_respond_enabled: !on }); router.refresh() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
      })}
        className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold border ${on ? 'bg-green-600 border-green-600 text-white' : 'bg-white border-gray-300 text-gray-800'} disabled:opacity-50`}>
        <span className={`h-2.5 w-2.5 rounded-full ${on ? 'bg-white' : 'bg-gray-400'}`} />Auto-Respond: {on ? 'ON' : 'OFF'}
      </button>
      <span className="text-xs text-gray-600">
        {on
          ? <>Cassie sends replies that pass every check at or above <b>{Math.round(settings.confidence_threshold * 100)}%</b> confidence after a <b>{settings.hold_minutes}-minute</b> hold. Everything else still comes here. Turning this off pulls back anything queued.</>
          : canEnable ? 'Every reply is a draft for a person to approve. Turn on only after the regression set exists and the unedited rate is above 95%.' : 'Every reply is a draft. Connect the mailbox and turn Processing on before this can be enabled.'}
      </span>
      {err && <span className="text-xs text-red-700">{err}</span>}
    </div>
  )
}

export function AutoSendCard({ settings: s, items }: { settings: AgentSettings; items: ReviewItem[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(s.confidence_threshold)
  const [types, setTypes] = useState<QuestionType[]>(s.auto_question_types)
  const [tiers, setTiers] = useState<MatchTier[]>(s.auto_match_tiers)
  const [hold, setHold] = useState(s.hold_minutes)

  // The 30 days of composed replies (any status) leading up to the newest one — what the
  // current knobs would have done. Anchored on the data, not the clock, so it is pure.
  const recent = useMemo(() => {
    const newest = items.reduce((m, i) => Math.max(m, Date.parse(i.created_at) || 0), 0)
    const cutoff = newest - 30 * 86_400_000
    return items.filter(i => i.confidence != null && Date.parse(i.created_at) >= cutoff)
  }, [items])
  const est = useMemo(() => estimateAutoShare(recent, { ...s, confidence_threshold: threshold, auto_question_types: types, auto_match_tiers: tiers }), [recent, s, threshold, types, tiers])
  const dirty = threshold !== s.confidence_threshold || hold !== s.hold_minutes || types.join() !== s.auto_question_types.join() || tiers.join() !== s.auto_match_tiers.join()
  const paused = Object.entries(s.paused_tiers)

  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Auto-send</h2>
      <p className="text-xs text-gray-500 mb-3">What Cassie may send without a person. A draft must clear every hard rule (grounded, one job, fresh read, one question) AND everything below. The estimate re-runs the real routing over the last 30 days of drafts as you move the controls.</p>

      <div className="grid md:grid-cols-2 gap-5">
        <div>
          <label className="block text-sm text-gray-700 font-medium mb-1">Confidence threshold <span className="text-gray-900 font-semibold">{Math.round(threshold * 100)}%</span></label>
          <input type="range" min={0.5} max={1} step={0.01} value={threshold} onChange={e => setThreshold(Number(e.target.value))} className="w-full" />
          <div className="mt-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
            {recent.length === 0
              ? <span className="text-gray-500">No drafts in the last 30 days yet. Replay a few emails or connect the mailbox and the estimate will appear here.</span>
              : <>
                <div className="text-gray-900"><b>{Math.round(est.share * 100)}%</b> of the last {est.total} draft{est.total === 1 ? '' : 's'} would have auto-sent at these settings ({est.wouldAutoSend} of {est.total}).</div>
                {Object.keys(est.blockedBy).length > 0 && (
                  <ul className="mt-1 text-xs text-gray-600 space-y-0.5">
                    {Object.entries(est.blockedBy).sort((a, b) => b[1] - a[1]).map(([k, n]) => <li key={k}>{n} held: {REASON_LABEL[k] ?? k}</li>)}
                  </ul>
                )}
              </>}
          </div>
          <label className="block text-sm text-gray-700 font-medium mt-4 mb-1">Hold before an auto-send goes out</label>
          <div className="flex items-center gap-2 text-sm text-gray-800"><input type="number" min={0} max={240} value={hold} onChange={e => setHold(Number(e.target.value))} className="w-20 border border-gray-300 rounded px-2 py-1 text-sm text-gray-900" /> minutes <span className="text-xs text-gray-500">— a Castle reply in the thread during the hold cancels the send; the job is re-read at send time.</span></div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="text-sm text-gray-700 font-medium mb-1">Auto-send focus area</div>
            <ul className="space-y-1">{FOCUS.map(f => (
              <li key={f.key}><label className="flex items-start gap-2 text-sm text-gray-800"><input type="checkbox" className="mt-1" checked={types.includes(f.key)} onChange={e => setTypes(t => e.target.checked ? [...t, f.key] : t.filter(x => x !== f.key))} /><span>{f.label} <span className="text-xs text-gray-400">{f.hint}</span></span></label></li>
            ))}</ul>
            <p className="text-xs text-gray-400 mt-1">Ship dates, pricing, warranty, reschedules, complaints and multi-part emails are always drafted, never auto-sent.</p>
          </div>
          <div>
            <div className="text-sm text-gray-700 font-medium mb-1">Match tiers eligible for auto-send</div>
            <ul className="space-y-1">{TIERS.map(t => (
              <li key={t.key}><label className="flex items-start gap-2 text-sm text-gray-800"><input type="checkbox" className="mt-1" checked={tiers.includes(t.key)} onChange={e => setTiers(x => e.target.checked ? [...x, t.key] : x.filter(y => y !== t.key))} /><span>{t.label} <span className="text-xs text-gray-400">{t.hint}</span></span></label></li>
            ))}</ul>
          </div>
          {paused.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <div className="font-semibold mb-1">Paused by confusion rate</div>
              <ul>{paused.map(([k, v]) => <li key={k}>{k.replace(':', ' via ')} — since {new Date(v.since).toLocaleDateString()} ({Math.round(v.rate * 100)}% confused)</li>)}</ul>
              <button className="mt-2 underline" disabled={pending} onClick={() => start(async () => { await saveAgentSettings({ paused_tiers: {} } as Partial<AgentSettings>); router.refresh() })}>Clear pauses</button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button className={btn} disabled={pending || !dirty} onClick={() => start(async () => {
          setMsg(null)
          try { await saveAgentSettings({ confidence_threshold: threshold, auto_question_types: types, auto_match_tiers: tiers, hold_minutes: hold }); setMsg('Saved.'); router.refresh() } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
        })}>Save auto-send settings</button>
        {msg && <span className={`text-sm ${msg === 'Saved.' ? 'text-green-700' : 'text-red-700'}`}>{msg}</span>}
      </div>
    </div>
  )
}
