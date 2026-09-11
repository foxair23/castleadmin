'use client'

import { useState, useTransition } from 'react'
import type { HealthReport } from '@/lib/ops/health'
import { sendCommandAction, confirmManualChecklistAction, cancelCommandAction } from './actions'

export interface RunRow { id: string; device: string | null; kind: string; site: string | null; mode: string | null; status: string; reason: string | null; source: string | null; started_at: string | null; finished_at: string | null; counts: Record<string, unknown> | null; log: unknown[] | null; version: string | null; created_at: string }
export interface CommandRow { id: string; kind: string; args: Record<string, unknown>; status: string; created_at: string; claimed_at: string | null; finished_at: string | null; result: unknown }

const TONE = { green: 'bg-green-100 text-green-800 border-green-200', amber: 'bg-amber-100 text-amber-800 border-amber-200', red: 'bg-red-100 text-red-800 border-red-200' }
const DOT = { green: 'bg-green-500', amber: 'bg-amber-500', red: 'bg-red-600' }
const fmt = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const btn = 'text-xs px-2.5 py-1 rounded border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 disabled:opacity-50'
const btnDark = 'text-xs px-2.5 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50'

export default function OpsHealthClient({ report, runs, commands, heartbeat, currentVersion }: { report: HealthReport; runs: RunRow[]; commands: CommandRow[]; heartbeat: { device: string; version: string | null; last_seen_at: string; state: Record<string, unknown> | null } | null; currentVersion: string }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const st = (heartbeat?.state ?? {}) as Record<string, unknown>
  const send = (kind: string, args: Record<string, unknown> = {}, label?: string) => start(async () => {
    setMsg(null)
    const r = await sendCommandAction(kind, args)
    setMsg(r.ok ? `Queued: ${label ?? kind}. The extension picks it up on its next report (within ~10 min, or right away on its next poll).` : (r.error ?? 'failed'))
  })
  const toggle = (key: string, current: unknown, label: string) => send('set_config', { key, value: !(current === true) }, `${label} → ${current === true ? 'OFF' : 'ON'}`)
  const checklistDone = report.checklist.filter(c => c.ok).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-900">Automation Health</h1>
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${TONE[report.overall]}`}><span className={`h-2 w-2 rounded-full ${DOT[report.overall]}`} />{report.overall === 'green' ? 'All good' : report.overall === 'amber' ? 'Needs a look' : 'Something is wrong'}</span>
        <span className="text-xs text-gray-500">evaluated {fmt(report.at)} PT</span>
        {msg && <span className="text-xs text-gray-700">{msg}</span>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {report.cards.map(c => (
          <div key={c.key} className={`rounded-lg border p-3 ${TONE[c.state]}`}>
            <div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${DOT[c.state]}`} /><span className="text-sm font-semibold">{c.label}</span></div>
            <ul className="mt-1.5 space-y-0.5 text-xs">{c.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </div>))}
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Remote control</h2>
        <p className="text-xs text-gray-500 mt-0.5">Buttons queue a command; the extension on the office machine picks it up on its next report and acknowledges below.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={btnDark} disabled={pending} onClick={() => send('run_now', {}, 'Run now (Service Fusion)')}>Run now</button>
          <button className={btn} disabled={pending} onClick={() => send('crawl', { site: 'genie', mode: 'incremental' }, 'Genie incremental crawl')}>Genie crawl</button>
          <button className={btn} disabled={pending} onClick={() => send('crawl', { site: 'genie', mode: 'full' }, 'Genie full crawl')}>Genie full</button>
          <button className={btn} disabled={pending} onClick={() => send('crawl', { site: 'clopay', mode: 'incremental' }, 'Clopay incremental crawl')}>Clopay crawl</button>
          <button className={btn} disabled={pending} onClick={() => send('crawl', { site: 'clopay', mode: 'full' }, 'Clopay full crawl')}>Clopay full</button>
          <button className={btn} disabled={pending} onClick={() => send('crawl', { site: 'clopay', mode: 'docs' }, 'Clopay document sync')}>Clopay docs</button>
          <button className={btn} disabled={pending} onClick={() => send('relogin', { site: 'genie' }, 'Re-login Genie')}>Re-login Genie</button>
          <button className={btn} disabled={pending} onClick={() => send('relogin', { site: 'clopay' }, 'Re-login Clopay')}>Re-login Clopay</button>
          <button className={btn} disabled={pending} onClick={() => send('relogin', { site: 'service_fusion' }, 'Re-login Service Fusion')}>Re-login SF</button>
          <button className={btn} disabled={pending} onClick={() => send('clear_badge', {}, 'Clear badge')}>Clear badge</button>
        </div>
        {heartbeat && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {([['enabled', 'Auto-poll'], ['dryRun', 'Dry run'], ['genieScheduleEnabled', 'Genie schedule'], ['clopayScheduleEnabled', 'Clopay schedule'], ['clopayDocSyncEnabled', 'Clopay doc sync']] as const).map(([k, label]) => (
              <button key={k} className={`${btn} ${st[k] === true ? 'border-green-500' : 'border-gray-300'}`} disabled={pending} title={`Click to turn ${st[k] === true ? 'OFF' : 'ON'}`} onClick={() => toggle(k, st[k], label)}>
                {label}: <strong>{st[k] === true ? 'ON' : st[k] === false ? 'OFF' : '?'}</strong>
              </button>))}
          </div>)}
        {commands.length > 0 && (
          <table className="mt-3 min-w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1 pr-3">Queued</th><th className="py-1 pr-3">Command</th><th className="py-1 pr-3">Status</th><th className="py-1 pr-3">Result</th><th></th></tr></thead>
            <tbody>{commands.map(c => (
              <tr key={c.id} className="border-t border-gray-100">
                <td className="py-1 pr-3 text-gray-700">{fmt(c.created_at)}</td>
                <td className="py-1 pr-3 text-gray-900">{c.kind}{Object.keys(c.args ?? {}).length ? ` ${JSON.stringify(c.args)}` : ''}</td>
                <td className="py-1 pr-3"><span className={`px-1.5 py-0.5 rounded ${c.status === 'done' ? 'bg-green-100 text-green-700' : c.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{c.status}</span></td>
                <td className="py-1 pr-3 text-gray-600 max-w-[320px] truncate" title={c.result ? JSON.stringify(c.result) : ''}>{c.result ? JSON.stringify(c.result).slice(0, 120) : c.finished_at ? fmt(c.finished_at) : ''}</td>
                <td>{c.status === 'pending' && <button className={btn} disabled={pending} onClick={() => start(async () => { await cancelCommandAction(c.id) })}>Cancel</button>}</td>
              </tr>))}</tbody>
          </table>)}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900">Leave-it-alone checklist</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full ${checklistDone === report.checklist.length ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>{checklistDone} / {report.checklist.length}</span>
          <span className="text-xs text-gray-500">Everything green here before leaving the machine unattended. Current extension: {currentVersion}.</span>
        </div>
        <ul className="mt-2 space-y-1 text-sm">
          {report.checklist.map(c => (
            <li key={c.key} className="flex items-start gap-2">
              <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full text-[10px] flex items-center justify-center ${c.ok ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-600'}`}>{c.ok ? '✓' : ''}</span>
              <span className={c.ok ? 'text-gray-700' : 'text-gray-900'}>{c.label}{c.detail ? <span className="text-gray-500"> · {c.detail}</span> : null}
                {c.key === 'manual' && <button className={`${btn} ml-2`} disabled={pending} onClick={() => start(async () => { await confirmManualChecklistAction(!c.ok) })}>{c.ok ? 'Un-confirm' : 'Confirm'}</button>}
              </span>
            </li>))}
        </ul>
        <div className="mt-3 text-xs text-gray-600 space-y-1">
          <div className="font-medium text-gray-800">Machine settings (Mac):</div>
          <div>System Settings → Energy / Battery: turn off “Put display to sleep” is fine, but set the computer to never sleep and “Prevent automatic sleeping when the display is off” on; if it is a laptop, keep it plugged in and open (closing the lid sleeps it).</div>
          <div>Chrome → Settings → System: “Continue running background apps when Chrome is closed” ON. Add Chrome to Login Items so a restart brings it back. Keep the extension pinned and Chrome signed into the profile that holds it.</div>
          <div>Turn off any other machine that runs the extension: two machines crawl twice and post twice.</div>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Recent runs</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1 pr-3">When (PT)</th><th className="py-1 pr-3">What</th><th className="py-1 pr-3">Outcome</th><th className="py-1 pr-3">Counts</th><th className="py-1 pr-3">Took</th><th></th></tr></thead>
            <tbody>{runs.map(r => {
              const ok = ['done', 'ok', 'budget', 'warm-ok'].includes(r.status)
              const mins = r.started_at && r.finished_at ? Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 60000) : null
              const counts = r.counts ? Object.entries(r.counts).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k} ${v}`).join(' · ') : ''
              return (
                <tr key={r.id} className="border-t border-gray-100 align-top">
                  <td className="py-1 pr-3 text-gray-700 whitespace-nowrap">{fmt(r.finished_at ?? r.created_at)}</td>
                  <td className="py-1 pr-3 text-gray-900 whitespace-nowrap">{r.kind}{r.site ? ` · ${r.site}` : ''}{r.mode ? ` · ${r.mode}` : ''}{r.source ? <span className="text-gray-400"> ({r.source})</span> : null}</td>
                  <td className="py-1 pr-3"><span className={`px-1.5 py-0.5 rounded ${ok ? 'bg-green-100 text-green-700' : r.status === 'started' ? 'bg-gray-100 text-gray-600' : 'bg-red-100 text-red-700'}`}>{r.reason && r.reason !== r.status ? `${r.status} · ${r.reason}` : r.status}</span></td>
                  <td className="py-1 pr-3 text-gray-600 max-w-[280px] truncate" title={counts}>{counts}</td>
                  <td className="py-1 pr-3 text-gray-500 whitespace-nowrap">{mins != null ? `${mins} min` : ''}</td>
                  <td>{r.log && r.log.length > 0 && <button className={btn} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide log' : `Log (${r.log.length})`}</button>}</td>
                </tr>)
            })}</tbody>
          </table>
          {open && <pre className="mt-2 max-h-96 overflow-auto rounded bg-gray-50 p-3 text-[11px] text-gray-800 whitespace-pre-wrap">{JSON.stringify(runs.find(r => r.id === open)?.log ?? [], null, 1)}</pre>}
          {runs.length === 0 && <p className="mt-2 text-xs text-gray-500">Nothing reported yet — the extension starts reporting with version 0.9.15.</p>}
        </div>
      </section>
    </div>
  )
}
