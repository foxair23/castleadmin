'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { RegressionCase, RegressionRun, WeekPoint } from '@/lib/agent/email/regression'
import { detectDrift } from '@/lib/agent/email/regression'
import { runRegressionAction, setRegressionCaseActive, deleteRegressionCase } from './actions'

// Dashboard (PRD §12) + the regression set (PRD §10, §14). The regression run is the
// prerequisite for Phase 2: Auto-Respond stays locked until a run with ≥ 30 cases exists.

const btn = 'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50'
const btnGhost = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const card = 'rounded-lg border border-gray-200 bg-white p-4'
const fmt = (s: string | null | undefined) => { if (!s) return '—'; const d = new Date(s); return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }
const pct = (n: number | null) => n == null ? '—' : `${Math.round(n * 100)}%`

export interface VolumeStats { processed: number; drafted: number; autoSent: number; humanSent: number; dropped: number; escalated: number; superseded: number; medianMinutesToSend: number | null }

export default function DashboardTab({ volume, cases, runs, trend, gmailOk }: { volume: VolumeStats; cases: RegressionCase[]; runs: RegressionRun[]; trend: WeekPoint[]; gmailOk: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(runs[0]?.id ?? null)
  const active = cases.filter(c => c.is_active)
  const latest = runs[0] ?? null, previous = runs[1] ?? null
  const editDrift = detectDrift(trend, 'editRate'), confDrift = detectDrift(trend, 'confusionRate')
  const baselineOk = runs.some(r => r.cases >= 30)

  return (
    <div className="space-y-4">
      {(editDrift.drifting || confDrift.drifting) && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          <b>Drift warning.</b> {editDrift.drifting && <>Edit rate over the last two weeks ({pct(editDrift.recent)}) is well above the prior month ({pct(editDrift.baseline)}). </>}
          {confDrift.drifting && <>Confusion rate over the last two weeks ({pct(confDrift.recent)}) is well above the prior month ({pct(confDrift.baseline)}). </>}
          A slow slide is the failure nobody catches: re-run the regression set and compare against the last good run before changing anything else.
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {([['Processed', volume.processed, 'last 30 days'], ['Drafted', volume.drafted, 'waited for a person'], ['Auto-sent', volume.autoSent, 'no person involved'], ['Sent by approval', volume.humanSent, 'approved or edited'],
           ['Dropped', volume.dropped, 'outside the perimeter'], ['Escalated', volume.escalated, 'handed to a person'], ['Superseded', volume.superseded, 'a person got there first'], ['Median to send', volume.medianMinutesToSend == null ? '—' : `${volume.medianMinutesToSend} min`, 'received → sent']] as [string, number | string, string][]).map(([label, n, hint]) => (
          <div key={label} className={card}><div className="text-2xl font-semibold text-gray-900">{n}</div><div className="text-sm text-gray-700">{label}</div><div className="text-xs text-gray-400">{hint}</div></div>
        ))}
      </div>

      <div className={card}>
        <div className="flex items-center gap-3 mb-1">
          <h2 className="text-sm font-semibold text-gray-900">Regression set</h2>
          <span className={`text-xs rounded px-2 py-0.5 ${baselineOk ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>{baselineOk ? 'baseline exists' : `${active.length} of 30 cases needed for a baseline`}</span>
          <span className={`text-xs rounded px-2 py-0.5 ${gmailOk ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>mailbox {gmailOk ? 'healthy' : 'not connected'}</span>
        </div>
        <p className="text-xs text-gray-500 mb-3">Real inquiries with a known-correct reply, each frozen with the job facts it was answered from. A run re-composes every case with today&apos;s model, prompt and charter and checks: grounded, every expected fact present, wording still close. Run it before and after any model or charter change. <b>Add cases from Review → Sent → &ldquo;Save as test case&rdquo;.</b></p>
        <div className="flex items-center gap-3 mb-3">
          <button className={btn} disabled={pending || active.length === 0} onClick={() => start(async () => {
            setMsg(null)
            try { const r = await runRegressionAction(); setMsg(`Run complete: ${r.passed} of ${r.cases} passed, mean score ${r.mean_score ?? '—'}.`); router.refresh() } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
          })}>{pending ? 'Running…' : `Run ${active.length} case${active.length === 1 ? '' : 's'}`}</button>
          <span className="text-xs text-gray-500">Takes roughly {Math.max(1, Math.ceil(active.length / 6))} minute{active.length > 6 ? 's' : ''}; each case is two model calls.</span>
          {msg && <span className="text-sm text-gray-700">{msg}</span>}
        </div>

        {latest && (
          <div className="grid sm:grid-cols-3 gap-3 mb-3 text-sm">
            <div className="rounded border border-gray-200 p-3"><div className="text-xs text-gray-500">Latest run · {fmt(latest.ran_at)}</div><div className="text-lg font-semibold text-gray-900">{latest.passed} / {latest.cases} passed</div><div className="text-xs text-gray-500">mean {latest.mean_score ?? '—'} · {latest.model} · charter v{latest.charter_version}</div></div>
            {previous && <div className="rounded border border-gray-200 p-3"><div className="text-xs text-gray-500">Previous · {fmt(previous.ran_at)}</div><div className="text-lg font-semibold text-gray-900">{previous.passed} / {previous.cases}</div><div className="text-xs text-gray-500">mean {previous.mean_score ?? '—'} · {previous.model} · charter v{previous.charter_version}</div></div>}
            {previous && latest.mean_score != null && previous.mean_score != null && (
              <div className={`rounded border p-3 ${Number(latest.mean_score) < Number(previous.mean_score) - 0.02 ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'}`}>
                <div className="text-xs text-gray-500">Change</div>
                <div className="text-lg font-semibold text-gray-900">{(Number(latest.mean_score) - Number(previous.mean_score)) >= 0 ? '+' : ''}{(Number(latest.mean_score) - Number(previous.mean_score)).toFixed(3)}</div>
                <div className="text-xs text-gray-600">{Number(latest.mean_score) < Number(previous.mean_score) - 0.02 ? 'Worse than the previous run. Look at the failing cases below before trusting the change.' : 'No regression detected.'}</div>
              </div>
            )}
          </div>
        )}

        {runs.length > 0 && (
          <div className="mb-3">
            <div className="flex gap-1 flex-wrap">{runs.slice(0, 8).map(r => <button key={r.id} onClick={() => setOpenRun(r.id)} className={`text-xs rounded-full border px-2 py-0.5 ${openRun === r.id ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-300'}`}>{fmt(r.ran_at)} · {r.passed}/{r.cases}</button>)}</div>
            {(() => { const r = runs.find(x => x.id === openRun); if (!r) return null; return (
              <ul className="mt-2 divide-y divide-gray-100 rounded border border-gray-200">
                {r.results.map(c => (
                  <li key={c.case_id} className="p-2 text-xs">
                    <div className="flex items-center gap-2"><span className={`rounded px-1.5 py-0.5 font-semibold ${c.passed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{c.passed ? 'pass' : 'fail'}</span><span className="text-gray-900">{c.name}</span><span className="text-gray-400">score {c.score}{c.question_type ? ` · ${c.question_type}` : ''}</span></div>
                    {c.error && <div className="text-red-700 mt-1">{c.error}</div>}
                    {!c.passed && !c.error && (
                      <div className="mt-1 text-gray-700">
                        {!c.grounded && <div className="text-red-800">Unsourced: {c.unsourced.join(' · ')}</div>}
                        {c.missing_values.length > 0 && <div>Missing from the reply: {c.missing_values.join(', ')}</div>}
                        {c.similarity < 0.25 && <div>Wording drifted (similarity {c.similarity}).</div>}
                        <details className="mt-1"><summary className="cursor-pointer text-gray-500">Show produced reply</summary><pre className="whitespace-pre-wrap font-sans mt-1 bg-gray-50 p-2 rounded">{c.produced_text}</pre></details>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) })()}
          </div>
        )}

        <details>
          <summary className="cursor-pointer text-xs text-gray-600">Cases ({cases.length})</summary>
          <ul className="mt-2 divide-y divide-gray-100">
            {cases.map(c => (
              <li key={c.id} className={`py-2 flex items-start gap-3 text-xs ${c.is_active ? '' : 'opacity-50'}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-gray-900">{c.name}{c.sf_job_number ? <span className="text-gray-400"> · job {c.sf_job_number}</span> : null}{c.question_type ? <span className="ml-1 rounded bg-gray-100 px-1 text-[10px]">{c.question_type}</span> : null}</div>
                  <div className="text-gray-500">last run {fmt(c.last_run_at)}{c.last_result ? ` · ${c.last_result.passed ? 'pass' : 'fail'} (${c.last_result.score})` : ''}</div>
                  <details className="mt-1"><summary className="cursor-pointer text-gray-400">Expected reply</summary><pre className="whitespace-pre-wrap font-sans mt-1 bg-gray-50 p-2 rounded text-gray-800">{c.expected_text}</pre></details>
                </div>
                <button className={btnGhost} disabled={pending} onClick={() => start(async () => { await setRegressionCaseActive(c.id, !c.is_active); router.refresh() })}>{c.is_active ? 'Disable' : 'Enable'}</button>
                <button className={btnGhost} disabled={pending} onClick={() => { if (confirm('Delete this test case?')) start(async () => { await deleteRegressionCase(c.id); router.refresh() }) }}>Delete</button>
              </li>
            ))}
          </ul>
        </details>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900 mb-1">Weekly trend <span className="text-xs text-gray-400 font-normal">— edit rate and confusion rate</span></h2>
        {trend.length === 0 ? <p className="text-sm text-gray-400">No data yet.</p> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1">Week of</th><th className="py-1 text-right">Drafts</th><th className="py-1 text-right">Edit rate</th><th className="py-1 text-right">Confusion</th></tr></thead>
            <tbody>{trend.map(p => <tr key={p.week} className="border-t border-gray-100 text-gray-800"><td className="py-1">{p.week}</td><td className="py-1 text-right">{p.drafts}</td><td className="py-1 text-right">{pct(p.editRate)}</td><td className="py-1 text-right">{pct(p.confusionRate)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </div>
  )
}
