'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { summarizeRatings } from '@/lib/csat/summary'
import type { CsatRow } from '@/lib/csat/metrics'
import type { CsatSettings } from '@/lib/csat/config'
import { setCsatEnabled, saveCsatSettings, updateFollowUp, setCsatScore, sendReviewRequestAction, type CsatSettingsInput } from './csat-actions'

interface Tech { id: string; full_name: string }
interface Props { settings: CsatSettings; rows: CsatRow[]; techs: Tech[] }

const INPUT = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900'

function fmtDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' })
}

function Tile({ big, label, tone = 'gray' }: { big: string; label: string; tone?: 'green' | 'amber' | 'red' | 'gray' | 'blue' }) {
  const tones: Record<string, string> = {
    green: 'bg-green-50 border-green-200 text-green-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    gray: 'bg-gray-50 border-gray-200 text-gray-700',
  }
  return (
    <div className={`flex-1 min-w-[120px] border rounded-lg px-4 py-3 ${tones[tone]}`}>
      <p className="text-2xl font-bold">{big}</p>
      <p className="text-xs mt-0.5">{label}</p>
    </div>
  )
}

export default function CsatTab({ settings, rows, techs }: Props) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(settings.enabled)
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // Filters
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [techFilter, setTechFilter] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [srcFilter, setSrcFilter] = useState('')

  const cats = useMemo(() => [...new Set(rows.map(r => r.job_category).filter(Boolean))].sort() as string[], [rows])
  const srcs = useMemo(() => [...new Set(rows.map(r => r.job_source).filter(Boolean))].sort() as string[], [rows])

  const filtered = useMemo(() => rows.filter(r => {
    if (from && (!r.sent_at || r.sent_at.slice(0, 10) < from)) return false
    if (to && (!r.sent_at || r.sent_at.slice(0, 10) > to)) return false
    if (techFilter && (r.primary_tech_user_id ?? `name:${r.primary_tech_name}`) !== techFilter) return false
    if (catFilter && r.job_category !== catFilter) return false
    if (srcFilter && r.job_source !== srcFilter) return false
    return true
  }), [rows, from, to, techFilter, catFilter, srcFilter])

  const sentRows = filtered.filter(r => r.sent_at)
  const ratings = filtered.map(r => r.rating).filter((n): n is number => n != null)
  const sum = summarizeRatings(ratings)
  const responseRate = sentRows.length ? Math.round((sum.responses / sentRows.length) * 100) : null
  const openCases = filtered.filter(r => r.follow_up_status === 'open').length

  // Per-tech breakdown (min-sample surfaced via the N column).
  const byTech = useMemo(() => {
    const m = new Map<string, { label: string; ratings: number[] }>()
    for (const r of filtered) {
      if (r.rating == null) continue
      const key = r.primary_tech_user_id ?? (r.primary_tech_name ? `name:${r.primary_tech_name}` : 'unassigned')
      const label = r.primary_tech_name ?? (techs.find(t => t.id === r.primary_tech_user_id)?.full_name) ?? 'Unassigned'
      const b = m.get(key) ?? { label, ratings: [] }
      b.ratings.push(r.rating)
      m.set(key, b)
    }
    return [...m.values()].map(b => ({ label: b.label, ...summarizeRatings(b.ratings) })).sort((a, b) => b.responses - a.responses)
  }, [filtered, techs])

  async function toggle() {
    setBusy(true)
    const next = !enabled
    setEnabled(next)
    try { await setCsatEnabled(next) } catch { setEnabled(!next) }
    setBusy(false)
    router.refresh()
  }

  function exportCsv() {
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const headers = ['Customer', 'Phone', 'Job', 'Sent', 'Responded', 'Rating', 'Feedback', 'Tech', 'Job Type', 'Source', 'City', 'ZIP', 'Follow-up']
    const lines = [headers.join(',')]
    for (const r of filtered) {
      lines.push([r.customer_name, r.phone_e164, r.sf_job_id, r.sent_at, r.responded_at, r.rating, r.feedback_text, r.primary_tech_name, r.job_category, r.job_source, r.city, r.postal_code, r.follow_up_status].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `csat-responses-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      {/* Master toggle */}
      <div className="flex items-center justify-between gap-4 flex-wrap border border-gray-200 rounded-lg px-4 py-3 bg-white">
        <div>
          <p className="font-semibold text-gray-900">Post-Job CSAT Survey</p>
          <p className="text-sm text-gray-500">Texts customers a 1–5 survey after a completed job. 5-star replies are asked for a Google review; 1–3 alerts the team.</p>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className={`px-4 py-2 rounded font-medium text-sm text-white disabled:opacity-50 ${enabled ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-400 hover:bg-gray-500'}`}
        >
          {enabled ? '● Service On' : '○ Service Off'}
        </button>
      </div>

      {/* Scorecard */}
      <div className="flex flex-wrap gap-3">
        <Tile big={sum.csat == null ? '—' : `${sum.csat}%`} label="CSAT (4–5 of valid)" tone="green" />
        <Tile big={sum.average == null ? '—' : sum.average.toFixed(1)} label="Avg rating / 5" tone="blue" />
        <Tile big={responseRate == null ? '—' : `${responseRate}%`} label="Response rate (of sent)" tone="gray" />
        <Tile big={String(sum.responses)} label="Valid responses" tone="gray" />
        <Tile big={String(sentRows.length)} label="Surveys sent" tone="gray" />
        <Tile big={String(openCases)} label="Open low-score cases" tone={openCases > 0 ? 'red' : 'gray'} />
      </div>

      {/* Rating distribution */}
      <div className="flex flex-wrap gap-2 text-sm">
        {(['5', '4', '3', '2', '1'] as const).map(k => (
          <span key={k} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-100 text-gray-700">
            <span className="font-semibold">{k}★</span> {sum.distribution[k]}
          </span>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-end">
        <label className="text-xs text-gray-600">From<input type="date" value={from} onChange={e => setFrom(e.target.value)} className={INPUT} /></label>
        <label className="text-xs text-gray-600">To<input type="date" value={to} onChange={e => setTo(e.target.value)} className={INPUT} /></label>
        <label className="text-xs text-gray-600">Tech
          <select value={techFilter} onChange={e => setTechFilter(e.target.value)} className={INPUT}>
            <option value="">All</option>
            {byTech.map(t => <option key={t.label} value={techs.find(x => x.full_name === t.label)?.id ?? `name:${t.label}`}>{t.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600">Job type
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className={INPUT}>
            <option value="">All</option>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600">Source
          <select value={srcFilter} onChange={e => setSrcFilter(e.target.value)} className={INPUT}>
            <option value="">All</option>
            {srcs.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button onClick={exportCsv} className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50">Export CSV</button>
      </div>

      {/* Per-tech breakdown */}
      {byTech.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-1">CSAT by technician</h3>
          <p className="text-xs text-gray-400 mb-2">Watch the response count (N) — a high score on a handful of responses isn’t comparable to one over many.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-y border-gray-200">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Technician</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">CSAT</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Avg</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">N</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Low (1–3)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {byTech.map(t => (
                  <tr key={t.label} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-900">{t.label}</td>
                    <td className="px-3 py-2 text-gray-700">{t.csat == null ? '—' : `${t.csat}%`}</td>
                    <td className="px-3 py-2 text-gray-700">{t.average == null ? '—' : t.average.toFixed(1)}</td>
                    <td className="px-3 py-2 text-gray-500">{t.responses}</td>
                    <td className="px-3 py-2 text-gray-700">{t.countLow}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Low-score queue */}
      <LowScoreQueue rows={filtered.filter(r => r.follow_up_status && r.follow_up_status !== 'resolved')} onRefresh={() => router.refresh()} />

      {/* Responses table */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Responses ({filtered.length})</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-y border-gray-200">
              <tr>
                {['Customer', 'Job', 'Sent', 'Rating', 'Conversation', 'Feedback', 'Tech', 'Job type', 'Status'].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.slice(0, 500).map(r => (
                <tr key={r.survey_id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">{r.customer_name ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-600">{r.sf_job_id}</td>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{fmtDate(r.sent_at)}</td>
                  <td className="px-3 py-2"><RatingCell row={r} onDone={() => router.refresh()} /></td>
                  <td className="px-3 py-2"><ConversationCell row={r} /></td>
                  <td className="px-3 py-2 text-gray-600"><div className="max-w-[220px] truncate" title={r.feedback_text ?? undefined}>{r.feedback_text ?? '—'}</div></td>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{r.primary_tech_name ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{r.job_category ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 500 && <p className="text-xs text-gray-400 mt-2">Showing first 500. Narrow the filters or export CSV for the full set.</p>}
        </div>
      </div>

      {/* Settings */}
      <div className="border-t border-gray-200 pt-4">
        <button onClick={() => setShowSettings(v => !v)} className="text-sm font-medium text-gray-700 hover:text-gray-900">
          {showSettings ? '▾' : '▸'} Settings
        </button>
        {showSettings && <SettingsPanel settings={settings} onSaved={() => router.refresh()} />}
      </div>
    </div>
  )
}

function RatingPill({ rating }: { rating: number }) {
  const tone = rating === 5 ? 'bg-green-100 text-green-800' : rating === 4 ? 'bg-blue-100 text-blue-800' : 'bg-red-100 text-red-800'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${tone}`}>{rating}★</span>
}

// Editable rating with provenance badge + (for 5s) the "send Google review" action.
function RatingCell({ row, onDone }: { row: CsatRow; onDone: () => void }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(String(row.rating ?? '5'))
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  const badge = row.rating_source === 'ai_correction'
    ? <span title="Score set from an AI-detected correction" className="text-[9px] uppercase tracking-wide text-purple-700 bg-purple-50 rounded px-1">AI</span>
    : row.rating_source === 'admin_edit'
    ? <span title="Score edited by an admin" className="text-[9px] uppercase tracking-wide text-amber-700 bg-amber-50 rounded px-1">edited</span>
    : null

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <select value={val} onChange={e => setVal(e.target.value)} disabled={pending} className="text-gray-900 border border-gray-300 rounded px-1 py-0.5 text-xs bg-white">
          {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}★</option>)}
        </select>
        <button disabled={pending} onClick={() => { setErr(null); start(async () => { const res = await setCsatScore(row.survey_id, Number(val)); if (res.ok) { setEditing(false); onDone() } else setErr(res.error ?? 'failed') }) }} className="text-xs text-blue-600 underline disabled:opacity-50">save</button>
        <button disabled={pending} onClick={() => { setEditing(false); setVal(String(row.rating ?? '5')) }} className="text-xs text-gray-400 underline">cancel</button>
        {err && <span className="text-[10px] text-red-600">{err}</span>}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {row.rating == null ? <span className="text-gray-300">—</span> : <RatingPill rating={row.rating} />}
      {badge}
      <button onClick={() => { setVal(String(row.rating ?? '5')); setEditing(true) }} title="Edit score" className="text-xs text-gray-400 hover:text-gray-700">✎</button>
      {row.rating === 5 && !row.review_requested_at && <ReviewRequestButton row={row} onDone={onDone} />}
    </span>
  )
}

function ReviewRequestButton({ row, onDone }: { row: CsatRow; onDone: () => void }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const held = row.review_pending_confirm
  return (
    <span className="inline-flex items-center gap-1">
      <button
        disabled={pending}
        onClick={() => { setMsg(null); start(async () => { const res = await sendReviewRequestAction(row.survey_id); setMsg(res.ok ? 'sent ✓' : (res.error ?? 'failed')); if (res.ok) onDone() }) }}
        title={held ? 'A 5 was set without auto-sending the Google-review text — send it now' : 'Send the Google-review request text'}
        className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap disabled:opacity-50 ${held ? 'bg-amber-100 text-amber-800 hover:bg-amber-200' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}
      >
        {pending ? 'sending…' : (held ? 'Send review (held)' : 'Send review')}
      </button>
      {msg && <span className="text-[10px] text-gray-500">{msg}</span>}
    </span>
  )
}

// Inline view of the customer's scored replies (shows corrections) + optional Dialpad link.
function ConversationCell({ row }: { row: CsatRow }) {
  const [open, setOpen] = useState(false)
  if (row.messages.length === 0 && !row.dialpad_url) return <span className="text-gray-300 text-xs">—</span>
  return (
    <div className="text-xs">
      {row.messages.length > 0 && (
        <>
          <button onClick={() => setOpen(o => !o)} className="text-blue-600 hover:text-blue-800 underline">{open ? 'hide' : `${row.messages.length} msg`}</button>
          {open && (
            <div className="mt-1 max-w-[260px] space-y-0.5">
              {row.messages.map((m, i) => (
                <div key={i} className="text-gray-700">
                  {m.rating != null && <span className="font-semibold">{m.rating}★ </span>}
                  <span className="text-gray-500">“{m.text ?? ''}”</span>
                  {m.source === 'ai_correction' && <span className="ml-1 text-purple-600">(AI)</span>}
                  {m.source === 'admin_edit' && <span className="ml-1 text-amber-600">(edit)</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {row.dialpad_url && <div><a href={row.dialpad_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Dialpad ↗</a></div>}
    </div>
  )
}

function LowScoreQueue({ rows, onRefresh }: { rows: CsatRow[]; onRefresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (rows.length === 0) return null
  async function act(surveyId: string, status: 'acknowledged' | 'resolved') {
    setBusy(surveyId)
    try { await updateFollowUp(surveyId, status) } catch { /* noop */ }
    setBusy(null)
    onRefresh()
  }
  return (
    <div className="border border-red-200 rounded-lg p-3 bg-red-50/40">
      <h3 className="text-sm font-semibold text-red-700 mb-2">Low-score recovery queue ({rows.length})</h3>
      <div className="space-y-2">
        {rows.map(r => (
          <div key={r.survey_id} className="flex items-center justify-between gap-3 flex-wrap bg-white border border-gray-200 rounded px-3 py-2">
            <div className="text-sm">
              <span className="font-medium text-gray-900">{r.customer_name ?? '—'}</span>
              <span className="ml-2"><RatingPill rating={r.rating ?? 0} /></span>
              <span className="ml-2 text-gray-500">Job {r.sf_job_id}{r.primary_tech_name ? ` · ${r.primary_tech_name}` : ''}</span>
              {r.feedback_text && <p className="text-xs text-gray-500 mt-0.5 max-w-lg">“{r.feedback_text}”</p>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">{r.follow_up_status}</span>
              {r.follow_up_status === 'open' && (
                <button onClick={() => act(r.survey_id, 'acknowledged')} disabled={busy === r.survey_id} className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Acknowledge</button>
              )}
              <button onClick={() => act(r.survey_id, 'resolved')} disabled={busy === r.survey_id} className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">Resolve</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SettingsPanel({ settings, onSaved }: { settings: CsatSettings; onSaved: () => void }) {
  const [form, setForm] = useState<CsatSettingsInput>({
    send_delay_minutes: settings.send_delay_minutes,
    send_start_hour_pt: settings.send_start_hour_pt,
    send_end_hour_pt: settings.send_end_hour_pt,
    alert_delay_minutes: settings.alert_delay_minutes,
    excluded_job_categories: settings.excluded_job_categories,
    excluded_sources: settings.excluded_sources,
    google_review_url: settings.google_review_url,
    survey_sms: settings.survey_sms,
    thanks_5_sms: settings.thanks_5_sms,
    ask_4_sms: settings.ask_4_sms,
    ack_low_sms: settings.ack_low_sms,
    clarify_sms: settings.clarify_sms,
    alert_extra_recipient_emails: settings.alert_extra_recipient_emails,
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const set = (patch: Partial<CsatSettingsInput>) => setForm(f => ({ ...f, ...patch }))
  const list = (arr: string[]) => arr.join(', ')
  const parseList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)

  async function save() {
    setSaving(true); setSaved(false)
    try { await saveCsatSettings(form); setSaved(true); onSaved() } catch { /* noop */ }
    setSaving(false)
  }

  return (
    <div className="mt-3 space-y-3 max-w-2xl">
      <div className="grid grid-cols-3 gap-3">
        <label className="text-xs text-gray-600">Delay after completion (min)
          <input type="number" value={form.send_delay_minutes} onChange={e => set({ send_delay_minutes: Number(e.target.value) })} className={INPUT} />
        </label>
        <label className="text-xs text-gray-600">Window start (PT hour)
          <input type="number" value={form.send_start_hour_pt} onChange={e => set({ send_start_hour_pt: Number(e.target.value) })} className={INPUT} />
        </label>
        <label className="text-xs text-gray-600">Window end (PT hour)
          <input type="number" value={form.send_end_hour_pt} onChange={e => set({ send_end_hour_pt: Number(e.target.value) })} className={INPUT} />
        </label>
      </div>
      <label className="text-xs text-gray-600 block">Low-score alert delay (min) — waits this long before emailing the team so the customer’s reply detail is included
        <input type="number" value={form.alert_delay_minutes} onChange={e => set({ alert_delay_minutes: Number(e.target.value) })} className={INPUT} />
      </label>
      <label className="text-xs text-gray-600 block">Google review link
        <input value={form.google_review_url} onChange={e => set({ google_review_url: e.target.value })} className={INPUT} />
      </label>
      <label className="text-xs text-gray-600 block">Excluded job types (comma-separated)
        <input value={list(form.excluded_job_categories)} onChange={e => set({ excluded_job_categories: parseList(e.target.value) })} className={INPUT} />
      </label>
      <label className="text-xs text-gray-600 block">Excluded job sources (comma-separated)
        <input value={list(form.excluded_sources)} onChange={e => set({ excluded_sources: parseList(e.target.value) })} className={INPUT} />
      </label>
      <label className="text-xs text-gray-600 block">Extra low-score alert emails (comma-separated)
        <input value={list(form.alert_extra_recipient_emails)} onChange={e => set({ alert_extra_recipient_emails: parseList(e.target.value) })} className={INPUT} />
      </label>
      {([
        ['Survey text', 'survey_sms'],
        ['5-star thank-you (use {{review_url}})', 'thanks_5_sms'],
        ['4-star follow-up', 'ask_4_sms'],
        ['1–3 acknowledgment', 'ack_low_sms'],
        ['Clarification', 'clarify_sms'],
      ] as const).map(([label, key]) => (
        <label key={key} className="text-xs text-gray-600 block">{label}
          <textarea value={form[key] as string} onChange={e => set({ [key]: e.target.value } as Partial<CsatSettingsInput>)} rows={2} className={`${INPUT} font-mono`} />
        </label>
      ))}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="px-4 py-2 rounded bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 disabled:opacity-50">{saving ? 'Saving…' : 'Save settings'}</button>
        {saved && <span className="text-sm text-green-600">Saved.</span>}
      </div>
    </div>
  )
}
