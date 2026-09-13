'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ReputationSettings, WorkingWindow, WeekdayKey, ReplyBand, CtaRule } from '@/lib/reputation/settings'
import type { Charter, Instruction, StyleExample } from '@/lib/agent/knowledge'
import type { ApprovalStats, BandStats } from '@/lib/reputation/reply-actions'
import {
  saveReputationSettings, saveReviewCharter, activateReviewCharter,
  createReviewInstruction, retireReviewInstruction, reactivateReviewInstruction,
  createReviewStyleExample, pinReviewStyleExample, removeReviewStyleExample, backfillTagsAction,
  savePostCharter, activatePostCharter, createPostInstruction, createPostStyleExample,
} from './reputation-actions'

// Reviews → Settings (PRD §9.1): the two autopilot switches with their stats, the
// pause, the humanized-send rules, the Reply Charter, standing instructions,
// style examples by band, and the model info + tag backfill.

export interface Props {
  settings: ReputationSettings
  models: { composer: string; classifier: string }
  llmConfigured: boolean
  charter: Charter
  versions: Charter[]
  instructions: Instruction[]
  styles: StyleExample[]
  stats: ApprovalStats
  // Profile posts (Phase 2)
  postCharter: Charter
  postVersions: Charter[]
  postInstructions: Instruction[]
  postStyles: StyleExample[]
  categories: string[]
}

const input = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 bg-white'
const btn = 'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50'
const btnGhost = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const card = 'rounded-lg border border-gray-200 bg-white p-4'
const DAYS: Array<{ key: WeekdayKey; label: string }> = [
  { key: 'mon', label: 'Monday' }, { key: 'tue', label: 'Tuesday' }, { key: 'wed', label: 'Wednesday' }, { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' }, { key: 'sat', label: 'Saturday' }, { key: 'sun', label: 'Sunday' },
]
const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' })
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const fromHHMM = (s: string) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0) }

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="block text-gray-700 font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-gray-400 mt-1">{hint}</span>}
    </label>
  )
}

function Switch({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" disabled={disabled} onClick={() => onChange(!on)}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium border ${on ? 'bg-green-600 border-green-600 text-white' : 'bg-white border-gray-300 text-gray-700'} disabled:opacity-50`}>
      <span className={`h-2.5 w-2.5 rounded-full ${on ? 'bg-white' : 'bg-gray-400'}`} />{label}: {on ? 'On' : 'Off'}
    </button>
  )
}

export default function ReputationSettingsTab(p: Props) {
  return (
    <div className="space-y-4 max-w-4xl">
      {!p.llmConfigured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <b>ANTHROPIC_API_KEY is not set.</b> Nothing is drafted or tagged until it is. Approving and skipping existing drafts still works.
        </div>
      )}
      <AutopilotCard settings={p.settings} stats={p.stats} />
      <WorkingWindowEditor settings={p.settings} />
      <StaggerCard settings={p.settings} />
      <CharterEditor title="Reply Charter" blurb="How Castle answers reviews: voice, what to thank for, how to handle a 3-star, the no-names rule. Included in every draft. Saving creates a new version; older versions stay." charter={p.charter} versions={p.versions} save={saveReviewCharter} activate={activateReviewCharter} />
      <InstructionsCard title="Standing instructions for replies" blurb="Short rules applied to every draft, e.g. “Invite gate customers to ask about maintenance plans.” These are separate from Cassie’s email rules." rows={p.instructions} create={createReviewInstruction} />
      <ReviewStyleExamplesCard rows={p.styles} />
      <h2 className="text-base font-semibold text-gray-900 pt-4">Profile posts</h2>
      <PostsCard settings={p.settings} categories={p.categories} />
      <CharterEditor title="Post Charter" blurb="How Castle writes profile posts: plain and local, one job per post, no names, no prices, no hashtags. Included in every post draft. Saving creates a new version; older versions stay." charter={p.postCharter} versions={p.postVersions} save={savePostCharter} activate={activatePostCharter} />
      <InstructionsCard title="Standing instructions for posts" blurb="Short rules applied to every post draft, e.g. “Mention same-day service when the job was booked and finished the same day.”" rows={p.postInstructions} create={createPostInstruction} />
      <PostStyleExamplesCard rows={p.postStyles} categories={p.categories} />
      <ModelsCard settings={p.settings} models={p.models} llmConfigured={p.llmConfigured} />
    </div>
  )
}

// ── Autopilot ───────────────────────────────────────────────────────────────

function StatLine({ s }: { s: BandStats }) {
  const human = s.unedited + s.edited
  const rate = human ? Math.round(s.unedited / human * 100) : null
  return <>{s.unedited} approved as written · {s.edited} edited{s.auto ? ` · ${s.auto} sent by autopilot` : ''}{rate != null ? ` · ${rate}% unedited` : ''}</>
}

function AutopilotCard({ settings: s, stats }: { settings: ReputationSettings; stats: ApprovalStats }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  const flip = (patch: Partial<ReputationSettings>) => start(async () => {
    setErr(null)
    const r = await saveReputationSettings(patch)
    if (r.error) setErr(r.error); else router.refresh()
  })
  const bands: Array<{ key: 'autopilot_positive' | 'autopilot_negative'; band: ReplyBand; label: string; hint: string }> = [
    { key: 'autopilot_positive', band: 'positive', label: 'Autopilot: 4–5 star replies', hint: 'On: drafts for 4 and 5 star reviews that pass every check are scheduled and sent without approval. Off: they wait under "Needs approval".' },
    { key: 'autopilot_negative', band: 'negative', label: 'Autopilot: 1–3 star replies', hint: 'Same for 1, 2 and 3 star reviews. There are fewer of these to learn from, so expect to keep it off longer. Every edit teaches the drafter.' },
  ]
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Autopilot</h2>
      <p className="text-xs text-gray-500 mb-4">Every review gets a draft either way. The switches decide whether a person approves it first. Turning a switch off pulls back anything autopilot had scheduled.</p>
      <div className="grid sm:grid-cols-2 gap-4">
        {bands.map(b => (
          <div key={b.key} className={`rounded-lg border p-3 ${s[b.key] ? 'border-green-300 bg-green-50' : 'border-gray-200'}`}>
            <Switch label={b.label} on={s[b.key]} disabled={pending} onChange={v => flip({ [b.key]: v })} />
            <p className="text-xs text-gray-600 mt-2">{b.hint}</p>
            <p className="text-xs text-gray-500 mt-2"><b>Last 30 days:</b> <StatLine s={stats[b.band].d30} /></p>
            <p className="text-xs text-gray-500"><b>Last 90 days:</b> <StatLine s={stats[b.band].d90} /></p>
          </div>
        ))}
      </div>
      <div className={`mt-4 rounded-lg border p-3 ${s.sends_paused ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
        <Switch label="Pause all sends" on={s.sends_paused} disabled={pending} onChange={v => flip({ sends_paused: v })} />
        <p className="text-xs text-gray-600 mt-2">Stops the sender without touching drafts or the switches. Scheduled replies and reminders wait and drip out one at a time when you unpause.</p>
      </div>
      {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
    </div>
  )
}

// ── Working window ──────────────────────────────────────────────────────────

function WorkingWindowEditor({ settings: s }: { settings: ReputationSettings }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [w, setW] = useState<WorkingWindow>(s.working_window)
  const [msg, setMsg] = useState<string | null>(null)
  const dirty = JSON.stringify(w) !== JSON.stringify(s.working_window)
  const setDay = (d: WeekdayKey, v: [number, number] | null) => setW(x => ({ ...x, [d]: v }))
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Working hours (Pacific)</h2>
      <p className="text-xs text-gray-500 mb-3">Replies and posts only go out inside these hours, so the profile looks like a person answering during the day. CSAT reminders use the CSAT texting window instead.</p>
      <div className="grid gap-2">
        {DAYS.map(d => {
          const v = w[d.key]
          return (
            <div key={d.key} className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2 w-32 text-gray-700"><input type="checkbox" checked={!!v} onChange={e => setDay(d.key, e.target.checked ? [460, 1100] : null)} />{d.label}</label>
              {v ? (
                <>
                  <input type="time" value={toHHMM(v[0])} onChange={e => setDay(d.key, [fromHHMM(e.target.value), v[1]])} className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-900" />
                  <span className="text-gray-400">to</span>
                  <input type="time" value={toHHMM(v[1])} onChange={e => setDay(d.key, [v[0], fromHHMM(e.target.value)])} className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-900" />
                </>
              ) : <span className="text-xs text-gray-400">closed</span>}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button className={btn} disabled={pending || !dirty} onClick={() => start(async () => { setMsg(null); const r = await saveReputationSettings({ working_window: w }); setMsg(r.error ?? 'Saved.'); if (!r.error) router.refresh() })}>Save hours</button>
        {dirty && <button className={btnGhost} disabled={pending} onClick={() => setW(s.working_window)}>Discard</button>}
        {msg && <span className="text-sm text-gray-600">{msg}</span>}
      </div>
    </div>
  )
}

// ── Stagger rules, caps, signature ──────────────────────────────────────────

function StaggerCard({ settings: s }: { settings: ReputationSettings }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [f, setF] = useState({
    reply_delay_min_hours: s.reply_delay_min_hours, reply_delay_max_hours: s.reply_delay_max_hours,
    min_gap_minutes: s.min_gap_minutes, max_gap_minutes: s.max_gap_minutes, skip_hour_pct: Math.round(s.skip_hour_ratio * 100),
    cap_new_replies: s.cap_new_replies, cap_backlog_replies: s.cap_backlog_replies, cap_posts: s.cap_posts, reply_signature: s.reply_signature,
  })
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))
  const num = (k: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} hint={hint}><input type="number" className={input} value={f[k] as number} onChange={e => set(k, Number(e.target.value) as never)} /></Field>
  )
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Send timing</h2>
      <p className="text-xs text-gray-500 mb-3">How sends are spread so nothing looks automated. Minutes are always nudged off :00, :15, :30 and :45.</p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {num('reply_delay_min_hours', 'Reply delay, min (hours)', 'after a new review is seen')}
        {num('reply_delay_max_hours', 'Reply delay, max (hours)')}
        {num('min_gap_minutes', 'Gap between sends, min (minutes)')}
        {num('max_gap_minutes', 'Gap between sends, max (minutes)')}
        {num('skip_hour_pct', 'Skipped hours (%)', 'share of each day’s hours with no sends at all')}
        {num('cap_new_replies', 'New replies per day')}
        {num('cap_backlog_replies', 'Backlog replies per day')}
        {num('cap_posts', 'Profile posts per day', 'the weekly cap is under Profile posts below')}
      </div>
      <div className="mt-3 max-w-sm">
        <Field label="Reply signature" hint="Added after every reply as “— signature”. Never a person’s name."><input className={input} value={f.reply_signature} onChange={e => set('reply_signature', e.target.value)} /></Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button className={btn} disabled={pending} onClick={() => start(async () => {
          setMsg(null)
          const r = await saveReputationSettings({
            reply_delay_min_hours: f.reply_delay_min_hours, reply_delay_max_hours: f.reply_delay_max_hours,
            min_gap_minutes: f.min_gap_minutes, max_gap_minutes: f.max_gap_minutes, skip_hour_ratio: f.skip_hour_pct / 100,
            cap_new_replies: f.cap_new_replies, cap_backlog_replies: f.cap_backlog_replies, cap_posts: f.cap_posts, reply_signature: f.reply_signature,
          })
          setMsg(r.error ?? 'Saved.'); if (!r.error) router.refresh()
        })}>Save timing</button>
        {msg && <span className="text-sm text-gray-600">{msg}</span>}
      </div>
    </div>
  )
}

// ── Charter editor (replies and posts) ──────────────────────────────────────

function CharterEditor({ title, blurb, charter, versions, save, activate }: {
  title: string; blurb: string; charter: Charter; versions: Charter[]
  save: (body: string, note: string) => Promise<{ error?: string }>; activate: (id: string) => Promise<{ error?: string }>
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [body, setBody] = useState(charter.body)
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const dirty = body !== charter.body
  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="text-sm font-semibold text-gray-900">{title} — version {charter.version}</h2>
        <p className="text-xs text-gray-500 mb-2">{blurb}</p>
        <textarea className={`${input} font-mono text-xs leading-relaxed`} rows={22} value={body} onChange={e => setBody(e.target.value)} />
        <div className="mt-3 flex items-center gap-3">
          <input className={`${input} max-w-md`} placeholder="What changed? (shown in version history)" value={note} onChange={e => setNote(e.target.value)} />
          <button className={btn} disabled={pending || !dirty} onClick={() => start(async () => { setMsg(null); const r = await save(body, note); setMsg(r.error ?? 'Saved as a new version.'); if (!r.error) { setNote(''); router.refresh() } })}>Save new version</button>
          {dirty && <button className={btnGhost} disabled={pending} onClick={() => setBody(charter.body)}>Discard</button>}
          {msg && <span className="text-sm text-gray-600">{msg}</span>}
        </div>
      </div>
      {versions.length > 1 && (
        <div className={card}>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Version history</h3>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-gray-500"><th className="py-1">Version</th><th>Note</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {versions.map(v => (
                <tr key={v.id} className="border-t border-gray-100">
                  <td className="py-1.5 text-gray-900">v{v.version} {v.is_active && <span className="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800">active</span>}</td>
                  <td className="text-gray-700">{v.note ?? '—'}</td>
                  <td className="text-gray-500">{fmt(v.created_at)}</td>
                  <td className="text-right">{!v.is_active && <button className={btnGhost} disabled={pending} onClick={() => start(async () => { await activate(v.id); router.refresh() })}>Make active</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Standing instructions (replies and posts) ───────────────────────────────

function InstructionsCard({ title, blurb, rows, create }: { title: string; blurb: string; rows: Instruction[]; create: (text: string) => Promise<{ error?: string }> }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const active = rows.filter(r => r.is_active), retired = rows.filter(r => !r.is_active)
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">{title}</h2>
      <p className="text-xs text-gray-500 mb-3">{blurb}</p>
      <div className="flex gap-2 mb-3">
        <input className={input} placeholder="Write a rule…" value={text} onChange={e => setText(e.target.value)} />
        <button className={btn} disabled={pending || !text.trim()} onClick={() => start(async () => { setErr(null); const r = await create(text); if (r.error) setErr(r.error); else { setText(''); router.refresh() } })}>Add</button>
      </div>
      {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
      <ul className="divide-y divide-gray-100">
        {active.map(r => (
          <li key={r.id} className="py-2 flex items-start gap-3 text-sm"><span className="flex-1 text-gray-900">{r.text}</span><button className={btnGhost} disabled={pending} onClick={() => start(async () => { await retireReviewInstruction(r.id); router.refresh() })}>Retire</button></li>
        ))}
        {active.length === 0 && <li className="py-2 text-sm text-gray-400">No rules yet.</li>}
      </ul>
      {retired.length > 0 && (
        <details className="mt-2"><summary className="text-xs text-gray-500 cursor-pointer">{retired.length} retired</summary>
          <ul className="divide-y divide-gray-100 mt-1">{retired.map(r => (
            <li key={r.id} className="py-2 flex items-start gap-3 text-sm"><span className="flex-1 text-gray-400 line-through">{r.text}</span><button className={btnGhost} disabled={pending} onClick={() => start(async () => { await reactivateReviewInstruction(r.id); router.refresh() })}>Restore</button></li>
          ))}</ul>
        </details>
      )}
    </div>
  )
}

// ── Style examples ──────────────────────────────────────────────────────────

const SOURCE: Record<string, string> = { pre_existing: 'Existing Google reply', staff: 'Pasted', human_edit: 'Edited draft', human_approved: 'Approved draft' }

function ReviewStyleExamplesCard({ rows }: { rows: StyleExample[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [band, setBand] = useState<ReplyBand>('positive')
  const [f, setF] = useState({ inquiry_text: '', final_text: '', stars: '' })
  const [err, setErr] = useState<string | null>(null)
  const list = rows.filter(r => r.audience === `review_${band}`)
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Style examples</h2>
      <p className="text-xs text-gray-500 mb-3">Paste 10–20 replies from the Google profiles you admire, one band at a time. Castle’s own existing replies were imported automatically, and every draft a person edits or approves is added here.</p>
      <div className="flex gap-1 mb-3">
        {(['positive', 'negative'] as ReplyBand[]).map(b => (
          <button key={b} onClick={() => setBand(b)} className={`px-3 py-1 text-sm rounded-full border ${band === b ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'}`}>{b === 'positive' ? '4–5 star' : '1–3 star'} ({rows.filter(r => r.audience === `review_${b}`).length})</button>
        ))}
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="The review" hint="optional"><textarea rows={4} className={input} value={f.inquiry_text} onChange={e => setF(x => ({ ...x, inquiry_text: e.target.value }))} /></Field>
        <Field label="The owner's reply"><textarea rows={4} className={input} value={f.final_text} onChange={e => setF(x => ({ ...x, final_text: e.target.value }))} /></Field>
      </div>
      <div className="mt-3 flex gap-3 items-center">
        <select className={`${input} w-32`} value={f.stars} onChange={e => setF(x => ({ ...x, stars: e.target.value }))}><option value="">Stars?</option>{(band === 'positive' ? [5, 4] : [3, 2, 1]).map(n => <option key={n} value={n}>{n} ★</option>)}</select>
        <button className={btn} disabled={pending || !f.final_text.trim()} onClick={() => start(async () => { setErr(null); const r = await createReviewStyleExample({ band, inquiry_text: f.inquiry_text, final_text: f.final_text, stars: f.stars ? Number(f.stars) : null }); if (r.error) setErr(r.error); else { setF({ inquiry_text: '', final_text: '', stars: '' }); router.refresh() } })}>Add example</button>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
      <ul className="divide-y divide-gray-100 mt-4">
        {list.map(r => (
          <li key={r.id} className="py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">{SOURCE[r.source] ?? r.source}{r.question_type ? ` · ${r.question_type} ★` : ''}{r.is_pinned ? ' · pinned' : ''}</div>
              {r.inquiry_text && <p className="text-xs text-gray-500 italic mb-1">&ldquo;{r.inquiry_text.slice(0, 300)}&rdquo;</p>}
              {r.ai_text && r.ai_text !== r.final_text && <p className="text-xs text-red-700/70 line-through mb-1">{r.ai_text.slice(0, 300)}</p>}
              <p className="text-sm text-gray-900 whitespace-pre-wrap">{r.final_text}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className={btnGhost} disabled={pending} onClick={() => start(async () => { await pinReviewStyleExample(r.id, !r.is_pinned); router.refresh() })}>{r.is_pinned ? 'Unpin' : 'Pin'}</button>
              <button className={btnGhost} disabled={pending} onClick={() => { if (confirm('Remove this example?')) start(async () => { await removeReviewStyleExample(r.id); router.refresh() }) }}>Delete</button>
            </div>
          </li>
        ))}
        {list.length === 0 && <li className="py-2 text-sm text-gray-400">No examples in this band yet.</li>}
      </ul>
    </div>
  )
}

// ── Profile posts: switch, caps, categories, buttons ────────────────────────

function PostsCard({ settings: s, categories }: { settings: ReputationSettings; categories: string[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [f, setF] = useState({ cap_posts_weekly: s.cap_posts_weekly, photo_min_score: s.photo_min_score, allowed: s.post_allowed_categories, rules: s.post_cta_map as CtaRule[] })
  const allCats = [...new Set([...categories, ...f.allowed])].sort()
  const toggleCat = (c: string) => setF(x => ({ ...x, allowed: x.allowed.includes(c) ? x.allowed.filter(a => a !== c) : [...x.allowed, c] }))
  const setRule = (i: number, patch: Partial<CtaRule>) => setF(x => ({ ...x, rules: x.rules.map((r, j) => j === i ? { ...r, ...patch } : r) }))
  const flip = (v: boolean) => start(async () => { setMsg(null); const r = await saveReputationSettings({ autopilot_posts: v }); setMsg(r.error ?? null); if (!r.error) router.refresh() })
  return (
    <div className={card}>
      <div className={`rounded-lg border p-3 ${s.autopilot_posts ? 'border-green-300 bg-green-50' : 'border-gray-200'}`}>
        <Switch label="Autopilot: profile posts" on={s.autopilot_posts} disabled={pending} onChange={flip} />
        <p className="text-xs text-gray-600 mt-2">On: a post whose photo scores above the bar and whose text passes every check is scheduled without approval. Off: every post waits under the Posts tab. Turning it off pulls back anything autopilot had scheduled. Every post is drafted either way.</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mt-4">
        <Field label="Posts per week, max" hint="Google profiles that post 1–4 times a week look active without looking automated. The daily cap under Send timing still applies."><input type="number" className={input} value={f.cap_posts_weekly} onChange={e => setF(x => ({ ...x, cap_posts_weekly: Number(e.target.value) }))} /></Field>
        <Field label="Photo bar (0–100)" hint="A photo must score at least this to be used without a person allowing it. Scores judge sharpness, framing, whether the work is the subject, and whether a customer, plate or address is visible."><input type="number" className={input} value={f.photo_min_score} onChange={e => setF(x => ({ ...x, photo_min_score: Number(e.target.value) }))} /></Field>
      </div>
      <div className="mt-4">
        <span className="block text-sm text-gray-700 font-medium mb-1">Job categories that can become posts</span>
        <p className="text-xs text-gray-400 mb-2">Leave every box unticked to allow all categories except warranty, estimate, service-call, callback and no-charge jobs, which never post.</p>
        <div className="flex flex-wrap gap-2">
          {allCats.map(c => (
            <label key={c} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs cursor-pointer ${f.allowed.includes(c) ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'}`}>
              <input type="checkbox" className="hidden" checked={f.allowed.includes(c)} onChange={() => toggleCat(c)} />{c}
            </label>
          ))}
          {allCats.length === 0 && <span className="text-xs text-gray-400">No categories mirrored from Service Fusion yet.</span>}
        </div>
      </div>
      <div className="mt-4">
        <span className="block text-sm text-gray-700 font-medium mb-1">Button on each post</span>
        <p className="text-xs text-gray-400 mb-2">Rules are tried top to bottom against the job category. The first match wins; the last rule is the fallback. Paths are on castlegarage.com.</p>
        <div className="space-y-2">
          {f.rules.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-gray-400 w-4">{i + 1}.</span>
              <input className={`${input} w-52`} placeholder="category matches… (regex)" value={r.match} onChange={e => setRule(i, { match: e.target.value })} />
              <span className="text-gray-400">→</span>
              <input className={`${input} w-64`} placeholder="/services/…" value={r.path} onChange={e => setRule(i, { path: e.target.value })} />
              <select className={`${input} w-32`} value={r.cta} onChange={e => setRule(i, { cta: e.target.value === 'CALL' ? 'CALL' : 'LEARN_MORE' })}><option value="LEARN_MORE">Learn more</option><option value="CALL">Call now</option></select>
              <button className="text-xs text-gray-500 underline" onClick={() => setF(x => ({ ...x, rules: x.rules.filter((_, j) => j !== i) }))}>remove</button>
            </div>
          ))}
        </div>
        <button className={`${btnGhost} mt-2`} onClick={() => setF(x => ({ ...x, rules: [...x.rules.slice(0, -1), { match: '', path: '/services/', cta: 'LEARN_MORE' }, ...x.rules.slice(-1)] }))}>Add rule</button>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button className={btn} disabled={pending} onClick={() => start(async () => {
          setMsg(null)
          const r = await saveReputationSettings({ cap_posts_weekly: f.cap_posts_weekly, photo_min_score: f.photo_min_score, post_allowed_categories: f.allowed, post_cta_map: f.rules })
          setMsg(r.error ?? 'Saved.'); if (!r.error) router.refresh()
        })}>Save posting rules</button>
        {msg && <span className="text-sm text-gray-600">{msg}</span>}
      </div>
    </div>
  )
}

function PostStyleExamplesCard({ rows, categories }: { rows: StyleExample[]; categories: string[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [f, setF] = useState({ final_text: '', category: '' })
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Post style examples</h2>
      <p className="text-xs text-gray-500 mb-3">Paste posts from the Google profiles you admire. Every post a person edits or approves is added here too, so the drafter learns Castle&rsquo;s voice.</p>
      <Field label="The post"><textarea rows={4} className={input} value={f.final_text} onChange={e => setF(x => ({ ...x, final_text: e.target.value }))} /></Field>
      <div className="mt-3 flex gap-3 items-center">
        <select className={`${input} w-56`} value={f.category} onChange={e => setF(x => ({ ...x, category: e.target.value }))}><option value="">Any job type</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <button className={btn} disabled={pending || !f.final_text.trim()} onClick={() => start(async () => { setErr(null); const r = await createPostStyleExample({ final_text: f.final_text, category: f.category || null }); if (r.error) setErr(r.error); else { setF({ final_text: '', category: '' }); router.refresh() } })}>Add example</button>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
      <ul className="divide-y divide-gray-100 mt-4">
        {rows.map(r => (
          <li key={r.id} className="py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">{SOURCE[r.source] ?? r.source}{r.question_type ? ` · ${r.question_type}` : ''}{r.is_pinned ? ' · pinned' : ''}</div>
              {r.ai_text && r.ai_text !== r.final_text && <p className="text-xs text-red-700/70 line-through mb-1">{r.ai_text.slice(0, 300)}</p>}
              <p className="text-sm text-gray-900 whitespace-pre-wrap">{r.final_text}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className={btnGhost} disabled={pending} onClick={() => start(async () => { await pinReviewStyleExample(r.id, !r.is_pinned); router.refresh() })}>{r.is_pinned ? 'Unpin' : 'Pin'}</button>
              <button className={btnGhost} disabled={pending} onClick={() => { if (confirm('Remove this example?')) start(async () => { await removeReviewStyleExample(r.id); router.refresh() }) }}>Delete</button>
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className="py-2 text-sm text-gray-400">No examples yet.</li>}
      </ul>
    </div>
  )
}

// ── Models + backfill ───────────────────────────────────────────────────────

function ModelsCard({ settings: s, models, llmConfigured }: { settings: ReputationSettings; models: { composer: string; classifier: string }; llmConfigured: boolean }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  async function backfill() {
    setRunning(true); setProgress('Tagging…')
    let total = 0
    for (let i = 0; i < 50; i++) {
      const r = await backfillTagsAction({})
      if (r.error) { setProgress(r.error); break }
      total += r.tagged ?? 0
      setProgress(`${total} tagged · ${r.remaining ?? 0} remaining`)
      if (!r.remaining || (r.tagged ?? 0) === 0) break
    }
    setRunning(false)
  }
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Models</h2>
      <p className="text-xs text-gray-500 mb-3">Shared with Cassie and managed by code.</p>
      <dl className="grid sm:grid-cols-3 gap-3 text-sm">
        <div><dt className="text-xs text-gray-500">Drafts replies</dt><dd className="text-gray-900 font-mono text-xs">{models.composer}</dd></div>
        <div><dt className="text-xs text-gray-500">Tags reviews</dt><dd className="text-gray-900 font-mono text-xs">{models.classifier}</dd></div>
        <div><dt className="text-xs text-gray-500">Prompt version</dt><dd className="text-gray-900">{s.prompt_version} · drafting new reviews since {fmt(s.draft_since)}</dd></div>
      </dl>
      <div className="mt-4 flex items-center gap-3">
        <button className={btnGhost} disabled={running || !llmConfigured} onClick={backfill}>{running ? 'Tagging…' : 'Tag untagged reviews'}</button>
        {progress && <span className="text-sm text-gray-600">{progress}</span>}
      </div>
    </div>
  )
}
