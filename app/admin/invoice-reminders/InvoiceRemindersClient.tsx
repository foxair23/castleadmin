'use client'

import { useState, useTransition } from 'react'
import { setEnabled, saveSettings, previewPlan, testDialpad, registerWebhook, addOptout, removeOptout } from './actions'

type Channel = 'email' | 'sms'
interface CadenceStage { day: number; channels: Channel[] }
interface Settings {
  enabled: boolean
  activated_at: string | null
  send_hour_pt: number
  excluded_sources: string[]
  cadence: CadenceStage[]
  email_subject: string
  email_body: string
  sms_body: string
}
interface LogRow {
  id: string; sf_invoice_id: string; sf_job_id: string | null; stage_day: number
  channel: string; recipient: string; status: string; error: string | null; amount_due: number | null; sent_at: string
}
interface Optout { id: string; channel: string; value: string; reason: string; created_at: string }
interface InboundEvent { id: string; received_at: string; verified: boolean; from_number: string | null; message_text: string | null; action: string }

interface Props {
  settings: Settings
  sources: string[]
  recent: LogRow[]
  optouts: Optout[]
  inbound: InboundEvent[]
  dialpadConfigured: boolean
}

function money(n: number | null): string {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function InvoiceRemindersClient({ settings: initial, sources, recent, optouts, inbound, dialpadConfigured }: Props) {
  const [isPending, startTransition] = useTransition()
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const [excluded, setExcluded] = useState<string[]>(initial.excluded_sources ?? [])
  const [sendHour, setSendHour] = useState(initial.send_hour_pt ?? 9)
  const [cadence, setCadence] = useState<CadenceStage[]>(initial.cadence?.length ? initial.cadence : [{ day: 7, channels: ['email'] }])
  const [emailSubject, setEmailSubject] = useState(initial.email_subject ?? '')
  const [emailBody, setEmailBody] = useState(initial.email_body ?? '')
  const [smsBody, setSmsBody] = useState(initial.sms_body ?? '')

  const [preview, setPreview] = useState<{ count: number; sample: { invoiceNumber: string | null; customerName: string | null; channel: string; recipient: string; stageDay: number; amountDue: number }[] } | null>(null)
  const [testNum, setTestNum] = useState('')
  const [testOut, setTestOut] = useState<string>('')
  const [optChannel, setOptChannel] = useState<Channel>('sms')
  const [optValue, setOptValue] = useState('')

  function flash(m: string) { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 4000) }
  function fail(e: unknown) { setErr(e instanceof Error ? e.message : String(e)); setMsg('') }

  function toggleEnabled() {
    startTransition(async () => {
      try { await setEnabled(!initial.enabled); flash(!initial.enabled ? 'Reminders enabled' : 'Reminders disabled') }
      catch (e) { fail(e) }
    })
  }

  function save() {
    startTransition(async () => {
      try {
        await saveSettings({ send_hour_pt: sendHour, excluded_sources: excluded, cadence, email_subject: emailSubject, email_body: emailBody, sms_body: smsBody })
        flash('Settings saved')
      } catch (e) { fail(e) }
    })
  }

  async function runPreview() {
    setErr(''); setPreview(null)
    try { setPreview(await previewPlan()) } catch (e) { fail(e) }
  }

  async function runTest() {
    setTestOut('Testing…')
    try {
      const r = await testDialpad(testNum)
      const parts = [`Auth: ${r.conn.ok ? 'OK' : 'FAIL'} (${r.conn.status}) ${r.conn.ok ? '' : r.conn.detail}`, `User id: ${r.conn.userId ?? '—'}`]
      if (r.send) parts.push(`Send: ${r.send.ok ? 'OK' : 'FAIL'} (${r.send.status}) ${r.send.ok ? `msg ${r.send.messageId}` : r.send.error}`)
      setTestOut(parts.join('\n'))
    } catch (e) { setTestOut(e instanceof Error ? e.message : String(e)) }
  }

  async function runRegisterWebhook() {
    setTestOut('Registering webhook…')
    try {
      const r = await registerWebhook()
      setTestOut(`Webhook ${r.ok ? 'registered' : 'FAILED'} — webhook ${r.webhookId ?? '—'}, subscription ${r.subscriptionId ?? '—'}\n${JSON.stringify(r.detail).slice(0, 400)}`)
    } catch (e) { setTestOut(e instanceof Error ? e.message : String(e)) }
  }

  const label = 'block text-sm font-medium text-gray-700 mb-1'
  const input = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500'

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Invoice Reminders</h1>
        <button
          onClick={toggleEnabled}
          disabled={isPending}
          className={`px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 ${initial.enabled ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-400 hover:bg-gray-500'}`}
        >
          {initial.enabled ? 'Enabled — click to turn OFF' : 'Disabled — click to turn ON'}
        </button>
      </div>
      <p className="text-sm text-gray-500 -mt-4">
        {initial.enabled
          ? `Active since ${initial.activated_at ? fmtDateTime(initial.activated_at) : '—'}. Only invoices reaching a new stage after that get reminded (fresh start).`
          : 'Off. Nothing sends until you enable it. Enabling starts fresh — the existing backlog is not chased.'}
      </p>

      {msg && <div className="bg-green-50 border border-green-200 rounded px-3 py-2 text-sm text-green-700">{msg}</div>}
      {err && <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">{err}</div>}

      {/* Dialpad */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-800 mb-2">Dialpad (SMS)</h2>
        <p className="text-xs mb-3">{dialpadConfigured ? <span className="text-green-600">Credentials detected.</span> : <span className="text-amber-600">DIALPAD_API_TOKEN / DIALPAD_FROM_NUMBER not set — SMS stays dormant.</span>}</p>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className={label}>Test — send to a phone</label>
            <input value={testNum} onChange={e => setTestNum(e.target.value)} placeholder="(760) 555-1234" className={input} />
          </div>
          <button onClick={runTest} className="px-3 py-2 text-sm rounded border border-gray-300 hover:bg-gray-50">Test connection + send</button>
          <button onClick={runRegisterWebhook} className="px-3 py-2 text-sm rounded border border-gray-300 hover:bg-gray-50">Register STOP webhook</button>
        </div>
        {testOut && <pre className="mt-3 text-xs bg-gray-50 border border-gray-200 rounded p-2 whitespace-pre-wrap">{testOut}</pre>}
      </section>

      {/* Cadence + settings */}
      <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-800">Cadence &amp; rules</h2>

        <div>
          <label className={label}>Reminder schedule (days after invoice date → channels)</label>
          <div className="space-y-2">
            {cadence.map((s, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-sm text-gray-500">After</span>
                <input
                  type="number" min={0} value={s.day}
                  onChange={e => setCadence(c => c.map((x, j) => j === i ? { ...x, day: Number(e.target.value) } : x))}
                  className="w-20 border border-gray-300 rounded px-2 py-1 text-sm text-gray-900"
                />
                <span className="text-sm text-gray-500">days →</span>
                {(['email', 'sms'] as Channel[]).map(ch => (
                  <label key={ch} className="flex items-center gap-1 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={s.channels.includes(ch)}
                      onChange={e => setCadence(c => c.map((x, j) => j === i ? { ...x, channels: e.target.checked ? [...x.channels, ch] : x.channels.filter(y => y !== ch) } : x))}
                    />
                    {ch.toUpperCase()}
                  </label>
                ))}
                <button onClick={() => setCadence(c => c.filter((_, j) => j !== i))} className="text-xs text-red-500 hover:text-red-700 ml-auto">Remove</button>
              </div>
            ))}
          </div>
          <button onClick={() => setCadence(c => [...c, { day: (c[c.length - 1]?.day ?? 0) + 7, channels: ['email'] }])} className="mt-2 text-sm text-blue-600 hover:text-blue-800">+ Add stage</button>
          <p className="text-xs text-gray-400 mt-1">The series stops after the last stage.</p>
        </div>

        <div>
          <label className={label}>Send hour (PT)</label>
          <input type="number" min={0} max={23} value={sendHour} onChange={e => setSendHour(Number(e.target.value))} className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-gray-900" />
        </div>

        <div>
          <label className={label}>Excluded Job Sources (3rd-party paid — skip these)</label>
          <div className="flex flex-wrap gap-2">
            {sources.length === 0 && <span className="text-xs text-gray-400">No SF sources synced yet.</span>}
            {sources.map(s => (
              <label key={s} className={`text-xs px-2 py-1 rounded-full border cursor-pointer ${excluded.includes(s) ? 'border-red-400 bg-red-50 text-red-700' : 'border-gray-200 text-gray-600'}`}>
                <input type="checkbox" className="hidden" checked={excluded.includes(s)} onChange={e => setExcluded(x => e.target.checked ? [...x, s] : x.filter(y => y !== s))} />
                {s}
              </label>
            ))}
          </div>
        </div>
      </section>

      {/* Templates */}
      <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-800">Message copy</h2>
        <p className="text-xs text-gray-400">Placeholders: {'{{customer}}'} {'{{invoice_number}}'} {'{{amount_due}}'} {'{{pay_url}}'} {'{{business_name}}'}</p>
        <div>
          <label className={label}>Email subject</label>
          <input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} className={input} />
        </div>
        <div>
          <label className={label}>Email body</label>
          <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} rows={7} className={`${input} font-mono`} />
        </div>
        <div>
          <label className={label}>SMS body</label>
          <textarea value={smsBody} onChange={e => setSmsBody(e.target.value)} rows={3} className={`${input} font-mono`} />
          <p className="text-xs text-gray-400 mt-1">Keep it short. Must include an opt-out (e.g. &ldquo;Reply STOP to opt out&rdquo;).</p>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={isPending} className="px-4 py-2 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-700 disabled:opacity-40">Save settings</button>
        <button onClick={runPreview} className="px-4 py-2 border border-gray-300 text-sm rounded-lg hover:bg-gray-50">Dry-run preview</button>
      </div>

      {preview && (
        <section className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-800 mb-2">Next run would send {preview.count} message{preview.count === 1 ? '' : 's'}</h2>
          {preview.sample.length > 0 && (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-500"><th className="py-1">Invoice</th><th>Customer</th><th>Day</th><th>Channel</th><th>To</th><th className="text-right">Due</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {preview.sample.map((p, i) => (
                  <tr key={i}><td className="py-1 font-mono">{p.invoiceNumber ?? '—'}</td><td>{p.customerName ?? '—'}</td><td>{p.stageDay}d</td><td>{p.channel}</td><td className="font-mono">{p.recipient}</td><td className="text-right">{money(p.amountDue)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* Opt-outs */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-800 mb-2">Opt-outs ({optouts.length})</h2>
        <div className="flex gap-2 items-end mb-3">
          <select value={optChannel} onChange={e => setOptChannel(e.target.value as Channel)} className="border border-gray-300 rounded px-2 py-2 text-sm text-gray-900 bg-white">
            <option value="sms">SMS</option><option value="email">Email</option>
          </select>
          <input value={optValue} onChange={e => setOptValue(e.target.value)} placeholder={optChannel === 'sms' ? 'phone' : 'email'} className={input} />
          <button onClick={() => startTransition(async () => { try { await addOptout(optChannel, optValue); setOptValue(''); flash('Opt-out added') } catch (e) { fail(e) } })} className="px-3 py-2 text-sm rounded border border-gray-300 hover:bg-gray-50 whitespace-nowrap">Add</button>
        </div>
        <div className="max-h-48 overflow-y-auto divide-y divide-gray-100">
          {optouts.map(o => (
            <div key={o.id} className="flex items-center justify-between py-1.5 text-sm">
              <span className="text-gray-700"><span className="text-xs text-gray-400 uppercase mr-2">{o.channel}</span>{o.value}<span className="text-xs text-gray-400 ml-2">({o.reason})</span></span>
              <button onClick={() => startTransition(async () => { try { await removeOptout(o.id) } catch (e) { fail(e) } })} className="text-xs text-gray-400 hover:text-red-600">Remove</button>
            </div>
          ))}
        </div>
      </section>

      {/* Inbound webhook events (diagnostic) */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-800 mb-1">Inbound from Dialpad ({inbound.length})</h2>
        <p className="text-xs text-gray-400 mb-2">Raw record of what Dialpad posts to our webhook. STOP/HELP are often handled by Dialpad internally and won&rsquo;t appear here — opt-outs are then captured when a send is rejected.</p>
        {inbound.length === 0 ? <p className="text-sm text-gray-400">No inbound events received yet.</p> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1">When</th><th>From</th><th>Text</th><th>Action</th><th>Verified</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {inbound.map(e => (
                <tr key={e.id}>
                  <td className="py-1 whitespace-nowrap">{fmtDateTime(e.received_at)}</td>
                  <td className="font-mono">{e.from_number ?? '—'}</td>
                  <td className="max-w-[220px] truncate" title={e.message_text ?? undefined}>{e.message_text ?? '—'}</td>
                  <td>{e.action}</td>
                  <td>{e.verified ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Recent activity */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-800 mb-2">Recent activity</h2>
        {recent.length === 0 ? <p className="text-sm text-gray-400">Nothing sent yet.</p> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1">When</th><th>Invoice</th><th>Stage</th><th>Channel</th><th>To</th><th className="text-right">Due</th><th>Status</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {recent.map(r => (
                <tr key={r.id}>
                  <td className="py-1 whitespace-nowrap">{fmtDateTime(r.sent_at)}</td>
                  <td className="font-mono">{r.sf_invoice_id}</td>
                  <td>{r.stage_day}d</td>
                  <td>{r.channel}</td>
                  <td className="font-mono">{r.recipient}</td>
                  <td className="text-right">{money(r.amount_due)}</td>
                  <td className={r.status === 'sent' ? 'text-green-600' : 'text-red-600'} title={r.error ?? undefined}>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
