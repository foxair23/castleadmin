'use client'

import { useState, useTransition } from 'react'
import { prepareEsignDocAction, runPrepareSweepAction, classifyBacklogAction, inspectEsignDocAction, setEsignSettingsAction, sendEsignNowAction, runEsignSweepAction, resetSignatureAction, linkEsignJobsAction } from '../esign-actions'

export interface EsignRow {
  id: string; order_id: string; status: string; template_key: string | null; template_fingerprint: string | null
  external_id: string | null; customer_name: string | null; order_status: string | null; sf_job_number: string | null; start_date: string | null
  customer_sent_at: string | null; customer_asked_at: string | null; customer_signed_at: string | null
  tech_name: string | null; tech_sent_at: string | null; tech_signed_at: string | null
  completed_at: string | null; sf_uploaded_at: string | null; portal_uploaded_at: string | null; portal_uploaded_by: string | null
  has_prepared: boolean; has_completed: boolean; error: string | null; created_at: string
  customer_link: string; tech_link: string
}
export interface FingerprintRow { fingerprint: string; count: number; template_key: string | null; sample_doc_id: string; sample_external_id: string | null }
export interface SignedSample { id: string; external_id: string | null; url: string | null; created_at: string }

const STAGES: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: 'needs_template', label: 'Needs template', statuses: ['unrecognised_template'] },
  { key: 'awaiting_install', label: 'Awaiting install/delivery', statuses: ['found', 'prepared'] },
  { key: 'awaiting_customer', label: 'Awaiting customer', statuses: ['sent_customer'] },
  { key: 'awaiting_tech', label: 'Awaiting tech', statuses: ['customer_signed', 'sent_tech'] },
  { key: 'completed', label: 'Completed', statuses: ['tech_signed', 'completed', 'sf_uploaded'] },
  { key: 'done', label: 'Done', statuses: ['portal_uploaded'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
]
const stageOf = (status: string) => STAGES.find(s => s.statuses.includes(status))?.key ?? 'other'
const STATUS_LABEL: Record<string, string> = {
  found: 'found — not inspected yet', unrecognised_template: 'form version not pinned', prepared: 'prepared', sent_customer: 'sent to customer',
  customer_signed: 'customer signed', sent_tech: 'sent to tech', tech_signed: 'tech signed', completed: 'completed', sf_uploaded: 'on SF job',
  portal_uploaded: 'uploaded to Clopay', cancelled: 'cancelled',
}
const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }) : '—'
const btn = 'text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const btnDark = 'text-xs px-2.5 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50'

export default function SignaturesClient({ rows, fingerprints, uninspected, signedSamples, registeredCount, settings }: { rows: EsignRow[]; fingerprints: FingerprintRow[]; uninspected: number; signedSamples: SignedSample[]; registeredCount: number; settings: { enabled: boolean; enabledAt: string | null } }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [stage, setStage] = useState<string>('all')
  const [inspect, setInspect] = useState<{ id: string; text: string } | null>(null)
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(stageOf(r.status), (counts.get(stageOf(r.status)) ?? 0) + 1)
  const visible = stage === 'all' ? rows : rows.filter(r => stageOf(r.status) === stage)
  const run = (fn: () => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>, label: (r: Record<string, unknown>) => string) => start(async () => {
    setMsg(null)
    const r = await fn()
    setMsg(r.ok ? label(r) : (r.error ?? 'failed'))
  })

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Signatures</h1>
        <p className="text-sm text-gray-600 mt-1">Home Depot&rsquo;s lien waiver for each Clopay house: found in the portal, pre-filled, e-signed by the customer and the technician, filed on the SF job, uploaded back to Clopay. Nothing is sent until the setting is on.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500">Auto-send to customers (email + SMS: the morning of the work, the ask the day after, one reminder)</span>
          <button type="button" role="switch" aria-checked={settings.enabled} disabled={pending}
            onClick={() => run(() => setEsignSettingsAction(!settings.enabled), () => settings.enabled ? 'Auto-send is OFF' : 'Auto-send is ON — only documents found from now on are sent automatically')}
            title={settings.enabled ? `ON since ${fmt(settings.enabledAt)} — documents found before that are never auto-sent` : 'OFF — nothing is sent automatically'}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${settings.enabled ? 'bg-green-600' : 'bg-gray-300'} disabled:opacity-50`}>
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${settings.enabled ? 'translate-x-[18px]' : 'translate-x-1'}`} />
          </button>
          <span className={`px-2 py-0.5 rounded-full font-medium ${settings.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'}`}>{settings.enabled ? `ON since ${fmt(settings.enabledAt)}` : 'OFF'}</span>
          {settings.enabled && <button className={btn} disabled={pending} onClick={() => run(runEsignSweepAction, r => `Sweep: ${r.sent} sent, ${r.failed} failed, ${r.held} not due${(r.errors as string[])?.length ? ` · ${(r.errors as string[]).join('; ')}` : ''}`)}>Run sweep now</button>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className={btnDark} disabled={pending} onClick={() => run(classifyBacklogAction, r => `Classified ${r.looked}: ${r.lien_waiver} blank waiver(s), ${r.signed} signed, ${r.none} other · ${r.remaining} left`)}>Classify stored documents</button>
          <button className={btnDark} disabled={pending} onClick={() => run(runPrepareSweepAction, r => `Looked at ${r.looked}: ${r.prepared} prepared, ${r.unrecognised} need a template, ${r.failed} failed`)}>Prepare pending</button>
          <button className={btnDark} disabled={pending} title="Find each waiting document's SF job through the shared matcher (PO → name → email → phone) and store it. The job's start date is what decides when the customer is messaged." onClick={() => run(linkEsignJobsAction, r => `Looked at ${r.looked} without a job: linked ${r.linked}`)}>Link SF jobs</button>
          {uninspected > 0 && <span className="text-xs text-gray-500">{uninspected} found and not yet inspected</span>}
          {msg && <span className="text-xs text-gray-700">{msg}</span>}
        </div>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Form versions</h2>
        <p className="text-xs text-gray-500 mt-0.5">Every version of the blank we have seen. A version needs its layout pinned once — open the preview, note where each field and signature line sits (the ruler gives coordinates), and add it to <code className="rounded bg-gray-100 px-1">lib/esign/templates.ts</code>. {registeredCount} layout{registeredCount === 1 ? '' : 's'} registered.</p>
        {fingerprints.length === 0
          ? <p className="mt-2 text-xs text-gray-500">No blanks inspected yet — run <em>Prepare pending</em>.</p>
          : <table className="mt-2 min-w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1 pr-3">Fingerprint</th><th className="py-1 pr-3">Blanks</th><th className="py-1 pr-3">Layout</th><th className="py-1 pr-3">Sample</th><th className="py-1 pr-3"></th></tr></thead>
            <tbody>{fingerprints.map(f => (
              <tr key={f.fingerprint} className="border-t border-gray-100">
                <td className="py-1.5 pr-3 font-mono text-gray-900">{f.fingerprint}</td>
                <td className="py-1.5 pr-3 text-gray-900">{f.count}</td>
                <td className="py-1.5 pr-3">{f.template_key ? <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700">{f.template_key}</span> : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">not pinned</span>}</td>
                <td className="py-1.5 pr-3 text-gray-700">{f.sample_external_id ?? '—'}</td>
                <td className="py-1.5 pr-3 flex gap-1.5">
                  <a className={btn} href={`/api/admin/esign/preview/${f.sample_doc_id}`} target="_blank" rel="noreferrer">Preview</a>
                  <button className={btn} disabled={pending} onClick={() => start(async () => {
                    const r = await inspectEsignDocAction(f.sample_doc_id)
                    setInspect({ id: f.sample_doc_id, text: r.ok ? JSON.stringify({ fingerprint: r.fingerprint, template: r.template, pages: r.pageCount, sizes: r.pageSizes, fields: r.acroFields, firstPageText: r.firstPageText }, null, 2) : (r.error ?? 'failed') })
                  })}>Inspect</button>
                </td>
              </tr>))}</tbody>
          </table>}
        {inspect && <pre className="mt-3 max-h-80 overflow-auto rounded bg-gray-50 p-3 text-[11px] text-gray-800 whitespace-pre-wrap">{inspect.text}</pre>}
        {signedSamples.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-medium text-gray-700">Signed forms that came back from Clopay — where the signature and date boxes really are:</div>
            <div className="mt-1 flex flex-wrap gap-2">{signedSamples.map(s => s.url
              ? <a key={s.id} className={btn} href={s.url} target="_blank" rel="noreferrer">{s.external_id ?? 'signed'} · {fmt(s.created_at)}</a>
              : <span key={s.id} className="text-xs text-gray-400">{s.external_id ?? 'signed'}</span>)}</div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900 mr-2">Documents</h2>
          <button className={`text-xs px-2 py-0.5 rounded ${stage === 'all' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700'}`} onClick={() => setStage('all')}>All {rows.length}</button>
          {STAGES.map(s => <button key={s.key} className={`text-xs px-2 py-0.5 rounded ${stage === s.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700'}`} onClick={() => setStage(s.key)}>{s.label} {counts.get(s.key) ?? 0}</button>)}
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1 pr-3">Order</th><th className="py-1 pr-3">Customer</th><th className="py-1 pr-3">SF job</th><th className="py-1 pr-3">Install</th><th className="py-1 pr-3">Status</th><th className="py-1 pr-3">Customer</th><th className="py-1 pr-3">Tech</th><th className="py-1 pr-3">Found</th><th className="py-1 pr-3"></th></tr></thead>
            <tbody>{visible.map(r => (
              <tr key={r.id} className="border-t border-gray-100 align-top">
                <td className="py-1.5 pr-3 text-gray-900">{r.external_id ?? '—'}</td>
                <td className="py-1.5 pr-3 text-gray-900">{r.customer_name ?? '—'}</td>
                <td className="py-1.5 pr-3 text-gray-700">{r.sf_job_number ?? '—'}</td>
                <td className="py-1.5 pr-3 text-gray-700">{r.start_date ?? '—'}</td>
                <td className="py-1.5 pr-3">
                  <span className={`rounded px-1.5 py-0.5 ${r.status === 'unrecognised_template' ? 'bg-amber-100 text-amber-700' : r.status === 'portal_uploaded' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  {r.error && <div className="text-[10px] text-red-600 max-w-[220px] whitespace-normal">{r.error}</div>}
                </td>
                <td className="py-1.5 pr-3 text-gray-700">{r.customer_signed_at ? `signed ${fmt(r.customer_signed_at)}` : r.customer_asked_at ? `asked ${fmt(r.customer_asked_at)}` : r.customer_sent_at ? `sent ${fmt(r.customer_sent_at)}` : '—'}</td>
                <td className="py-1.5 pr-3 text-gray-700">{r.tech_signed_at ? `signed ${fmt(r.tech_signed_at)}` : r.tech_sent_at ? `sent ${fmt(r.tech_sent_at)}${r.tech_name ? ` · ${r.tech_name}` : ''}` : '—'}</td>
                <td className="py-1.5 pr-3 text-gray-500">{fmt(r.created_at)}</td>
                <td className="py-1.5 pr-3 flex gap-1.5">
                  {['found', 'unrecognised_template', 'prepared'].includes(r.status) && <button className={btn} disabled={pending} onClick={() => run(() => prepareEsignDocAction(r.id), x => `${x.status}${x.fingerprint ? ` · ${x.fingerprint}` : ''}`)}>Prepare</button>}
                  {r.template_fingerprint && <a className={btn} href={`/api/admin/esign/preview/${r.id}`} target="_blank" rel="noreferrer">Preview</a>}
                  {r.customer_signed_at && !['sf_uploaded', 'portal_uploaded', 'cancelled'].includes(r.status) && (
                    <button className={`${btn} text-red-700`} disabled={pending} title="Wipe the customer's signature (and the tech's, if any) so the link works again"
                      onClick={() => { if (confirm(`Clear ${r.customer_name ?? 'the customer'}'s signature${r.tech_signed_at ? ' AND the technician\'s' : ''}? The signing link will work again.`)) run(() => resetSignatureAction(r.id, 'customer'), x => `Customer signature cleared · now ${x.status}`) }}>Clear customer signature</button>)}
                  {r.tech_signed_at && !['sf_uploaded', 'portal_uploaded', 'cancelled'].includes(r.status) && (
                    <button className={`${btn} text-red-700`} disabled={pending} title="Wipe the technician's signature so their link works again"
                      onClick={() => { if (confirm('Clear the technician\'s signature? Their link will work again.')) run(() => resetSignatureAction(r.id, 'tech'), x => `Tech signature cleared · now ${x.status}`) }}>Clear tech signature</button>)}
                  {r.has_prepared && r.status !== 'cancelled' && <>
                    <button className={btn} title={r.customer_link} onClick={() => { navigator.clipboard.writeText(r.customer_link); setMsg('Customer link copied') }}>Customer link</button>
                    <button className={btn} title={r.tech_link} onClick={() => { navigator.clipboard.writeText(r.tech_link); setMsg('Tech link copied') }}>Tech link</button>
                  </>}
                  {['found', 'prepared', 'sent_customer'].includes(r.status) && !r.customer_signed_at && (
                    <select className={`${btn} text-gray-900 bg-white`} disabled={pending} value="" title="Send a message to the customer now — regardless of the auto-send setting"
                      onChange={e => { const v = e.target.value as '' | 'heads_up' | 'ask' | 'reminder'; if (!v) return; if (!confirm(`Send the ${v === 'heads_up' ? 'heads-up (link ahead of the work)' : v === 'ask' ? '"please sign"' : 'reminder'} to ${r.customer_name ?? 'this customer'} now?`)) return; run(() => sendEsignNowAction(r.id, v), x => `Sent via ${(x.channels as string[]).join(', ')}${x.warning ? ` · ${x.warning}` : ''}`) }}>
                      <option value="">Send now…</option>
                      <option value="heads_up">Heads-up (link ahead of the work)</option>
                      <option value="ask">Please sign (work is done)</option>
                      <option value="reminder">Reminder</option>
                    </select>)}
                </td>
              </tr>))}</tbody>
          </table>
          {visible.length === 0 && <p className="mt-2 text-xs text-gray-500">Nothing here.</p>}
        </div>
      </section>
    </div>
  )
}
