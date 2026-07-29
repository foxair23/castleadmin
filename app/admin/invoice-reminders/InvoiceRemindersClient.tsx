'use client'

import { useState, useTransition } from 'react'
import { setEnabled, saveSettings, previewPlan, testDialpad, registerWebhook } from './actions'
import { renderInvoiceReminderEmail } from '@/lib/notifications/templates/invoice-reminder-email'

// Sample data for previews, so placeholders resolve to something realistic.
const SAMPLE_VARS: Record<string, string> = {
  customer: 'Jane Sample', invoice_number: '#181181161', amount_due: '$450.00', pay_url: '#', business_name: 'Castle Garage Inc',
}
function fillVars(tpl: string): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => SAMPLE_VARS[k] ?? '')
}

type Channel = 'email' | 'sms'
interface CadenceStage {
  day: number
  channels: Channel[]
  email_subject: string
  email_body: string
  sms_body: string
}
interface Settings {
  enabled: boolean
  activated_at: string | null
  send_hour_pt: number
  excluded_sources: string[]
  cadence: CadenceStage[]
}
interface LogRow {
  id: string; sf_invoice_id: string; sf_job_id: string | null; stage_day: number
  channel: string; recipient: string; status: string; error: string | null; amount_due: number | null; sent_at: string
}
interface InboundEvent { id: string; received_at: string; verified: boolean; from_number: string | null; message_text: string | null; action: string }

interface Props {
  settings: Settings
  sources: string[]
  recent: LogRow[]
  inbound: InboundEvent[]
  dialpadConfigured: boolean
}

function money(n: number | null): string {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const EMPTY_STAGE: CadenceStage = { day: 7, channels: ['email'], email_subject: '', email_body: '', sms_body: '' }

export default function InvoiceRemindersClient({ settings: initial, sources, recent, inbound, dialpadConfigured }: Props) {
  const [isPending, startTransition] = useTransition()
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const [excluded, setExcluded] = useState<string[]>(initial.excluded_sources ?? [])
  const [sendHour, setSendHour] = useState(initial.send_hour_pt ?? 9)
  const [cadence, setCadence] = useState<CadenceStage[]>(initial.cadence?.length ? initial.cadence : [{ ...EMPTY_STAGE }])

  const [preview, setPreview] = useState<{ count: number; sample: { invoiceNumber: string | null; customerName: string | null; channel: string; recipient: string; stageDay: number; amountDue: number }[] } | null>(null)
  const [testNum, setTestNum] = useState('')
  const [testOut, setTestOut] = useState('')

  function flash(m: string) { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 4000) }
  function fail(e: unknown) { setErr(e instanceof Error ? e.message : String(e)); setMsg('') }

  function patchStage(i: number, patch: Partial<CadenceStage>) {
    setCadence(c => c.map((s, j) => j === i ? { ...s, ...patch } : s))
  }
  function toggleChannel(i: number, ch: Channel, on: boolean) {
    patchStage(i, { channels: on ? [...cadence[i].channels, ch] : cadence[i].channels.filter(x => x !== ch) })
  }
  // Render the branded email with this stage's current (unsaved) copy + sample
  // data, and open it in a new tab inside a Desktop/Mobile preview frame.
  function previewEmail(s: CadenceStage) {
    const { html } = renderInvoiceReminderEmail({
      bodyText: fillVars(s.email_body),
      invoiceNumber: SAMPLE_VARS.invoice_number,
      amountDue: SAMPLE_VARS.amount_due,
      payUrl: '#',
    })
    // Embed the email in a resizable frame. <-escape so nothing in the
    // email HTML can break out of the injecting <script>.
    const emailJson = JSON.stringify(html).replace(/</g, '\\u003c')
    const wrapper = `<!doctype html><html><head><meta charset="utf-8"><title>Email preview</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#e5e7eb;}
  .bar{position:sticky;top:0;padding:10px;text-align:center;background:#0F0F0F;color:#fff;}
  .bar span{font-size:13px;margin-right:10px;opacity:.8;}
  .bar button{margin:0 4px;padding:7px 18px;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;background:#fff;color:#111;}
  .bar button.active{background:#C81E1E;color:#fff;}
  .wrap{display:flex;justify-content:center;padding:20px;}
  iframe{border:1px solid #b0b0b0;background:#fff;height:82vh;transition:width .15s;box-shadow:0 4px 24px rgba(0,0,0,.15);}
</style></head><body>
  <div class="bar"><span>Preview width:</span>
    <button id="d" class="active" onclick="setW('100%',this)">Desktop</button>
    <button id="m" onclick="setW('390px',this)">Mobile</button>
  </div>
  <div class="wrap"><iframe id="f" style="width:100%"></iframe></div>
  <script>
    document.getElementById('f').srcdoc = ${emailJson};
    function setW(w,btn){document.getElementById('f').style.width=w;document.querySelectorAll('.bar button').forEach(function(b){b.className='';});btn.className='active';}
  </script>
</body></html>`
    const url = URL.createObjectURL(new Blob([wrapper], { type: 'text/html' }))
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  function toggleEnabled() {
    startTransition(async () => {
      try { await setEnabled(!initial.enabled); flash(!initial.enabled ? 'Reminders enabled' : 'Reminders disabled') }
      catch (e) { fail(e) }
    })
  }
  function save() {
    startTransition(async () => {
      try { await saveSettings({ send_hour_pt: sendHour, excluded_sources: excluded, cadence }); flash('Settings saved') }
      catch (e) { fail(e) }
    })
  }
  async function runPreview() {
    setErr(''); setPreview(null)
    try { setPreview(await previewPlan({ cadence, excluded_sources: excluded })) } catch (e) { fail(e) }
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
      setTestOut(`Webhook ${r.ok ? 'registered' : 'FAILED'} — webhook ${r.webhookId ?? '—'}, subscription ${r.subscriptionId ?? '—'}`)
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
          <button onClick={runTest} className="px-3 py-2 text-sm rounded border border-gray-400 text-gray-800 hover:bg-gray-100">Test connection + send</button>
          <button onClick={runRegisterWebhook} className="px-3 py-2 text-sm rounded border border-gray-400 text-gray-800 hover:bg-gray-100">Register STOP webhook</button>
        </div>
        {testOut && <pre className="mt-3 text-xs bg-gray-50 border border-gray-200 rounded p-2 whitespace-pre-wrap">{testOut}</pre>}
      </section>

      {/* Global settings */}
      <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-800">Global settings</h2>
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

      {/* Reminder schedule + per-stage copy */}
      <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">Reminder schedule &amp; message copy</h2>
          <p className="text-xs text-gray-400 mt-0.5">Each stage fires that many days after the invoice date, with its own copy — ramp up the tone as it ages. The series stops after the last stage. Placeholders: {'{{customer}}'} {'{{invoice_number}}'} {'{{amount_due}}'} {'{{pay_url}}'}. Email copy is wrapped in the branded template automatically.</p>
        </div>

        {cadence.map((s, i) => (
          <div key={i} className="border border-gray-200 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-gray-700">Reminder {i + 1}</span>
              <span className="text-sm text-gray-500">— after</span>
              <input type="number" min={0} value={s.day} onChange={e => patchStage(i, { day: Number(e.target.value) })} className="w-20 border border-gray-300 rounded px-2 py-1 text-sm text-gray-900" />
              <span className="text-sm text-gray-500">days via</span>
              {(['email', 'sms'] as Channel[]).map(ch => (
                <label key={ch} className="flex items-center gap-1 text-sm text-gray-700">
                  <input type="checkbox" checked={s.channels.includes(ch)} onChange={e => toggleChannel(i, ch, e.target.checked)} />
                  {ch.toUpperCase()}
                </label>
              ))}
              <button onClick={() => setCadence(c => c.filter((_, j) => j !== i))} className="text-xs text-red-500 hover:text-red-700 ml-auto">Remove</button>
            </div>

            {s.channels.includes('email') && (
              <div className="space-y-2 pl-1">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Email subject</label>
                  <input value={s.email_subject} onChange={e => patchStage(i, { email_subject: e.target.value })} className={input} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Email message</label>
                  <textarea value={s.email_body} onChange={e => patchStage(i, { email_body: e.target.value })} rows={5} className={`${input} font-mono text-xs`} />
                </div>
                <button
                  onClick={() => previewEmail(s)}
                  className="text-xs px-3 py-1.5 rounded border border-gray-400 text-gray-800 hover:bg-gray-100"
                >
                  Preview email ↗
                </button>
              </div>
            )}
            {s.channels.includes('sms') && (
              <div className="pl-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">SMS text</label>
                <textarea value={s.sms_body} onChange={e => patchStage(i, { sms_body: e.target.value })} rows={2} className={`${input} font-mono text-xs`} />
                <p className="text-[11px] text-gray-400 mt-1">Keep it short and include an opt-out (e.g. &ldquo;Reply STOP to opt out&rdquo;).</p>
              </div>
            )}
          </div>
        ))}
        <button onClick={() => setCadence(c => [...c, { ...EMPTY_STAGE, day: (c[c.length - 1]?.day ?? 0) + 7 }])} className="text-sm text-blue-600 hover:text-blue-800">+ Add reminder</button>
      </section>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={isPending} className="px-4 py-2 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-700 disabled:opacity-40">Save settings</button>
        <button onClick={runPreview} className="px-4 py-2 bg-white border border-gray-400 text-gray-800 text-sm font-medium rounded-lg hover:bg-gray-100">Dry-run preview</button>
      </div>

      {preview && (
        <section className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-800 mb-1">{preview.count} message{preview.count === 1 ? '' : 's'} match your current schedule</h2>
          <p className="text-xs text-gray-500 mb-2">Everything eligible under the cadence above (uses your unsaved edits). With fresh start, an enabled run only sends invoices that cross a <em>new</em> stage after you turn it on, so real runs start smaller than this.</p>
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

      {/* Inbound webhook events (diagnostic) */}
      <section className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-800 mb-1">Inbound from Dialpad ({inbound.length})</h2>
        <p className="text-xs text-gray-400 mb-2">Raw record of what Dialpad posts to our webhook. STOP is usually handled by Dialpad internally and won&rsquo;t appear here — the engine also stops texting a number if a send is rejected for opt-out.</p>
        {inbound.length === 0 ? <p className="text-sm text-gray-400">No inbound events received yet.</p> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1">When</th><th>From</th><th>Text</th><th>Action</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {inbound.map(e => (
                <tr key={e.id}>
                  <td className="py-1 whitespace-nowrap">{fmtDateTime(e.received_at)}</td>
                  <td className="font-mono">{e.from_number ?? '—'}</td>
                  <td className="max-w-[220px] truncate" title={e.message_text ?? undefined}>{e.message_text ?? '—'}</td>
                  <td>{e.action}</td>
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
