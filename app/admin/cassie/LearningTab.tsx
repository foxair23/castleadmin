'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { CoverageCluster, EditRate } from '@/lib/agent/email/learning'
import type { AnswerEntry } from '@/lib/agent/knowledge'
import { saveAnswer } from './actions'

// Learning (PRD §9). What Cassie could not answer, ranked by demand, each one tap from
// becoming an answer-library entry; and the edit rate that gates Phase 2.

const input = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 bg-white'
const btn = 'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50'
const btnGhost = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const card = 'rounded-lg border border-gray-200 bg-white p-4'

const fmtDate = (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }) }

export default function LearningTab({ clusters, editRates, answers, weeklyAsks }: { clusters: CoverageCluster[]; editRates: EditRate[]; answers: AnswerEntry[]; weeklyAsks: Array<{ week: string; count: number }> }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [writing, setWriting] = useState<string | null>(null)
  const [f, setF] = useState({ title: '', question_type: '', answer_text: '' })
  const [msg, setMsg] = useState<string | null>(null)

  // Has someone already written an answer that plausibly covers this cluster?
  const covered = useMemo(() => {
    const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 3))
    return (c: CoverageCluster) => answers.some(a => {
      if (!a.is_active) return false
      const cw = words(c.missing); let hit = 0
      for (const w of words(`${a.title} ${a.question_examples.join(' ')}`)) if (cw.has(w)) hit++
      return hit >= 2 || (a.question_type && a.question_type === c.questionType && hit >= 1)
    })
  }, [answers])

  const open = (c: CoverageCluster) => { setWriting(c.key); setF({ title: c.missing.slice(0, 120), question_type: c.questionType, answer_text: '' }); setMsg(null) }
  const total = clusters.reduce((n, c) => n + c.count, 0)

  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-1">What Cassie could not answer <span className="text-xs text-gray-400 font-normal">— last 90 days, {total} time{total === 1 ? '' : 's'}</span></h2>
        <p className="text-xs text-gray-500 mb-3">Every question she could not ground, grouped by what was missing and ranked by how often it comes up. This is the build list: things at the top are worth an answer-library entry (no developer needed) or, for anything that needs live data, an integration.</p>
        {clusters.length === 0 && <p className="text-sm text-gray-400">Nothing yet. This fills in as real emails arrive.</p>}
        <ul className="divide-y divide-gray-100">
          {clusters.map(c => (
            <li key={c.key} className="py-2">
              <div className="flex items-start gap-3">
                <div className="w-10 shrink-0 text-center"><div className="text-lg font-semibold text-gray-900">{c.count}</div><div className="text-[10px] uppercase tracking-wide text-gray-400">asks</div></div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900">{c.missing}</div>
                  <div className="text-xs text-gray-500">{c.questionType} · first {fmtDate(c.firstSeen)} · last {fmtDate(c.lastSeen)}{covered(c) && <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-800">answer exists</span>}</div>
                </div>
                {!covered(c) && <button className={btnGhost} onClick={() => open(c)}>Write an answer</button>}
              </div>
              {writing === c.key && (
                <div className="mt-2 rounded border border-gray-300 bg-gray-50 p-3 grid sm:grid-cols-2 gap-3">
                  <label className="text-sm"><span className="block text-gray-700 font-medium mb-1">Title</span><input className={input} value={f.title} onChange={e => setF(x => ({ ...x, title: e.target.value }))} /></label>
                  <label className="text-sm"><span className="block text-gray-700 font-medium mb-1">Question type</span><input className={input} value={f.question_type} onChange={e => setF(x => ({ ...x, question_type: e.target.value }))} /></label>
                  <label className="text-sm sm:col-span-2"><span className="block text-gray-700 font-medium mb-1">The answer, written the way Cassie should say it</span><textarea rows={4} className={input} value={f.answer_text} onChange={e => setF(x => ({ ...x, answer_text: e.target.value }))} placeholder="Only write something that is true every time. If the real answer needs live data we do not have, leave this and we will talk about an integration." /></label>
                  <div className="sm:col-span-2 flex items-center gap-2">
                    <button className={btn} disabled={pending || !f.answer_text.trim()} onClick={() => start(async () => {
                      try { await saveAnswer(null, { title: f.title, question_examples: [c.missing], question_type: f.question_type || null, answer_text: f.answer_text, audience: 'partner' }); setWriting(null); setMsg('Saved to the answer library. Cassie can use it from the next email.'); router.refresh() } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
                    })}>Save answer</button>
                    <button className={btnGhost} onClick={() => setWriting(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {msg && <p className="mt-2 text-sm text-green-700">{msg}</p>}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className={card}>
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Edit rate <span className="text-xs text-gray-400 font-normal">— last 30 days, by question type and match tier</span></h2>
          <p className="text-xs text-gray-500 mb-2">Share of approved drafts a person sent without changing a word. The PRD gate for turning on auto-send for a tier is 95% unedited.</p>
          {editRates.length === 0 ? <p className="text-sm text-gray-400">No human decisions yet.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-500"><th className="py-1">Question · tier</th><th className="py-1 text-right">Reviewed</th><th className="py-1 text-right">Unedited</th><th className="py-1 text-right">Edited</th><th className="py-1 text-right">Rejected</th><th className="py-1 text-right">Auto</th></tr></thead>
              <tbody>{editRates.map(r => (
                <tr key={r.key} className="border-t border-gray-100 text-gray-800">
                  <td className="py-1">{r.questionType} · {r.tier}</td>
                  <td className="py-1 text-right">{r.reviewed}</td>
                  <td className={`py-1 text-right font-medium ${r.uneditedRate >= 0.95 ? 'text-green-700' : ''}`}>{r.unedited} <span className="text-gray-400">({Math.round(r.uneditedRate * 100)}%)</span></td>
                  <td className="py-1 text-right">{r.edited}</td>
                  <td className="py-1 text-right">{r.rejected + r.escalated}</td>
                  <td className="py-1 text-right text-gray-500">{r.auto}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div className={card}>
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Asks per week</h2>
          <p className="text-xs text-gray-500 mb-2">How often Cassie needed a person (Chat ask or ungrounded draft). This should fall as the answer library grows, even while email volume holds.</p>
          {weeklyAsks.length === 0 ? <p className="text-sm text-gray-400">No data yet.</p> : (
            <div className="flex items-end gap-1 h-24">
              {weeklyAsks.map(w => { const max = Math.max(...weeklyAsks.map(x => x.count), 1); return (
                <div key={w.week} className="flex-1 flex flex-col items-center justify-end gap-1" title={`${w.week}: ${w.count}`}>
                  <div className="w-full rounded-t bg-gray-800" style={{ height: `${Math.max(4, (w.count / max) * 80)}px` }} />
                  <div className="text-[9px] text-gray-400">{w.week.slice(5)}</div>
                </div>
              ) })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
