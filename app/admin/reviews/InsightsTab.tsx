'use client'

import { useEffect, useState } from 'react'
import type { Insights } from '@/lib/reputation/insights'
import { THEME_LABEL } from '@/lib/reputation/theme-labels'

// Reviews → Insights (PRD §5): the review funnel, reply performance, what
// customers talk about, which techs they name, posts, and photo quality by
// tech. Same PT date range idea as the CSAT tab. Read-only.

const card = 'rounded-lg border border-gray-200 bg-white p-4'
const input = 'border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 bg-white'
const btnGhost = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const PT = 'America/Los_Angeles'
const ptDay = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86_400_000))
const pct = (n: number, d: number) => d ? `${Math.round(n / d * 100)}%` : '—'

const PRESETS: Array<{ label: string; days: number }> = [{ label: '7 days', days: 7 }, { label: '30 days', days: 30 }, { label: '90 days', days: 90 }, { label: '12 months', days: 365 }]

export default function InsightsTab() {
  const [from, setFrom] = useState(ptDay(-29))
  const [to, setTo] = useState(ptDay(0))
  const key = `${from}:${to}`
  const [data, setData] = useState<{ key: string; insights: Insights | null; threshold: number; err: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/admin/reviews/insights?from=${from}&to=${to}`)
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
        if (!cancelled) setData({ key, insights: j.insights, threshold: j.threshold, err: null })
      } catch (e) {
        if (!cancelled) setData({ key, insights: null, threshold: 70, err: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [from, to, key])
  const loading = data?.key !== key
  const ins = data?.insights ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map(p => (
          <button key={p.days} className={btnGhost} onClick={() => { setFrom(ptDay(-(p.days - 1))); setTo(ptDay(0)) }}>{p.label}</button>
        ))}
        <input type="date" className={input} value={from} max={to} onChange={e => setFrom(e.target.value)} />
        <span className="text-gray-400 text-sm">to</span>
        <input type="date" className={input} value={to} min={from} onChange={e => setTo(e.target.value)} />
        <span className="text-xs text-gray-400">Pacific days, inclusive{loading ? ' · loading…' : ''}</span>
      </div>
      {data?.err && <p className="text-sm text-red-600">{data.err}</p>}
      {ins && (
        <>
          <ReviewsRow ins={ins} />
          <div className="grid lg:grid-cols-2 gap-4">
            <FunnelCard ins={ins} />
            <RepliesCard ins={ins} />
          </div>
          <ThemesCard ins={ins} />
          <div className="grid lg:grid-cols-2 gap-4">
            <MentionsCard ins={ins} />
            <PostsCard ins={ins} />
          </div>
          <PhotosCard ins={ins} threshold={data?.threshold ?? 70} />
        </>
      )}
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

function ReviewsRow({ ins }: { ins: Insights }) {
  const r = ins.reviews
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Tile label="New Google reviews" value={r.count} sub={r.removed ? `${r.removed} removed` : undefined} />
      <Tile label="Average stars" value={r.avg != null ? r.avg.toFixed(2) : '—'} sub={`${r.byStar[5]} · ${r.byStar[4]} · ${r.byStar[3]} · ${r.byStar[2]} · ${r.byStar[1]} (5→1)`} />
      <Tile label="Answered" value={pct(ins.replies.replied, ins.replies.reviewsInWindow)} sub={`${ins.replies.unreplied} still open`} />
      <Tile label="Median time to answer" value={ins.replies.medianHours != null ? `${Math.round(ins.replies.medianHours)} h` : '—'} sub={ins.replies.timed ? `${pct(ins.replies.within24h, ins.replies.timed)} within a day` : 'no timed replies yet'} />
    </div>
  )
}

function FunnelCard({ ins }: { ins: Insights }) {
  const f = ins.funnel.total
  const steps: Array<{ label: string; n: number; of: number }> = [
    { label: 'Survey texts sent', n: f.sent, of: f.sent }, { label: 'Replied with a rating', n: f.responded, of: f.sent }, { label: 'Gave a 5', n: f.fives, of: f.responded },
    { label: 'Got the review link', n: f.linkSent, of: f.fives }, { label: 'Tapped the link', n: f.clicked, of: f.linkSent }, { label: 'Posted a review we matched', n: f.reviewed, of: f.linkSent },
  ]
  const max = Math.max(1, f.sent)
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Review funnel</h2>
      <p className="text-xs text-gray-500 mb-3">From survey text to a posted Google review. Reminders sent: {f.surveyReminders} survey, {f.reviewReminders} review-link. Matching a review to a job is fuzzy, so the last step undercounts.</p>
      <div className="space-y-1.5">
        {steps.map(s => (
          <div key={s.label} className="text-xs">
            <div className="flex justify-between text-gray-700"><span>{s.label}</span><span className="text-gray-500">{s.n} · {pct(s.n, s.of)}</span></div>
            <div className="h-2 rounded bg-gray-100"><div className="h-2 rounded bg-red-500" style={{ width: `${Math.round(s.n / max * 100)}%` }} /></div>
          </div>
        ))}
      </div>
      {ins.funnel.byTech.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-gray-500 cursor-pointer">By tech</summary>
          <div className="overflow-x-auto"><table className="w-full text-xs mt-2">
            <thead><tr className="text-left text-gray-500"><th className="py-1">Tech</th><th>Sent</th><th>Replied</th><th>5s</th><th>Link</th><th>Tapped</th><th>Reviewed</th></tr></thead>
            <tbody>{ins.funnel.byTech.map(t => (
              <tr key={t.tech} className="border-t border-gray-100 text-gray-800"><td className="py-1">{t.tech}</td><td>{t.sent}</td><td>{t.responded} <span className="text-gray-400">{pct(t.responded, t.sent)}</span></td><td>{t.fives}</td><td>{t.linkSent}</td><td>{t.clicked}</td><td>{t.reviewed}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
      )}
    </div>
  )
}

function RepliesCard({ ins }: { ins: Insights }) {
  const r = ins.replies
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Reply performance</h2>
      <p className="text-xs text-gray-500 mb-3">Reviews created in the range. Speed is measured from the review to the reply landing on Google.</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-gray-500">Answered</dt><dd className="text-gray-900">{r.replied} of {r.reviewsInWindow}</dd>
        <dt className="text-gray-500">Still open</dt><dd className="text-gray-900">{r.unreplied} <span className="text-xs text-gray-400">({r.waitingApproval} waiting for approval, {r.scheduled} scheduled)</span></dd>
        <dt className="text-gray-500">Within a day / two days</dt><dd className="text-gray-900">{pct(r.within24h, r.timed)} / {pct(r.within48h, r.timed)}</dd>
        <dt className="text-gray-500">Drafted by the agent</dt><dd className="text-gray-900">{r.byAgent} <span className="text-xs text-gray-400">({r.autopilot} on autopilot, {r.editedBeforeApproval} edited first)</span></dd>
        <dt className="text-gray-500">Written by hand</dt><dd className="text-gray-900">{r.byHand}{r.preExisting ? <span className="text-xs text-gray-400"> + {r.preExisting} from before the agent</span> : null}</dd>
      </dl>
    </div>
  )
}

function ThemesCard({ ins }: { ins: Insights }) {
  const rows = ins.themes.themes
  const max = Math.max(1, ...rows.map(t => t.positive + t.negative))
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">What customers talk about</h2>
      <p className="text-xs text-gray-500 mb-3">Themes tagged on each review. Green is 4–5 stars, red is 1–3. {ins.themes.untagged > 0 && <>{ins.themes.untagged} reviews are not tagged yet (Settings → Tag untagged reviews).</>}</p>
      <div className="grid md:grid-cols-2 gap-x-6 gap-y-2">
        {rows.map(t => (
          <div key={t.theme} className="text-xs">
            <div className="flex justify-between text-gray-700"><span>{THEME_LABEL[t.theme] ?? t.theme}</span><span className="text-gray-500">{t.positive} / <span className="text-red-600">{t.negative}</span></span></div>
            <div className="flex h-2 rounded bg-gray-100 overflow-hidden">
              <div className="h-2 bg-green-500" style={{ width: `${Math.round(t.positive / max * 100)}%` }} />
              <div className="h-2 bg-red-500" style={{ width: `${Math.round(t.negative / max * 100)}%` }} />
            </div>
            {t.quotes.map((q, i) => <p key={i} className={`mt-1 italic ${q.stars >= 4 ? 'text-gray-500' : 'text-red-700/80'}`}>&ldquo;{q.text}&rdquo; <span className="not-italic text-gray-400">{q.stars}★</span></p>)}
          </div>
        ))}
      </div>
    </div>
  )
}

function MentionsCard({ ins }: { ins: Insights }) {
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Techs customers name</h2>
      <p className="text-xs text-gray-500 mb-3">Names written in the review itself, and whether the job record agrees. For internal credit only; names are never echoed in replies or posts.</p>
      {ins.mentions.length === 0 ? <p className="text-sm text-gray-400">No names in this range.</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-gray-500"><th className="py-1">Name</th><th>Mentions</th><th>5★</th><th>Matches job</th><th>Differs</th></tr></thead>
          <tbody>{ins.mentions.map(m => (
            <tr key={m.name} className="border-t border-gray-100 text-gray-800"><td className="py-1">{m.name}</td><td>{m.mentions}</td><td>{m.fives}</td><td>{m.matchesCreditedTech}</td><td className={m.mismatches ? 'text-amber-700' : ''}>{m.mismatches}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  )
}

function PostsCard({ ins }: { ins: Insights }) {
  const p = ins.posts
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Profile posts</h2>
      <p className="text-xs text-gray-500 mb-3">Posts drafted from finished jobs in the range, and how many made it to the Google profile.</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-gray-500">Published</dt><dd className="text-gray-900">{p.published}</dd>
        <dt className="text-gray-500">Drafted</dt><dd className="text-gray-900">{p.drafted}</dd>
        <dt className="text-gray-500">Waiting for approval</dt><dd className="text-gray-900">{p.waitingApproval}</dd>
        <dt className="text-gray-500">Skipped / failed</dt><dd className="text-gray-900">{p.skipped} / {p.failed}</dd>
      </dl>
    </div>
  )
}

function PhotosCard({ ins, threshold }: { ins: Insights; threshold: number }) {
  const ph = ins.photos
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Job photo quality by tech</h2>
      <p className="text-xs text-gray-500 mb-3">Every photo pulled from Service Fusion is scored 0–100 for whether it could go on the profile (the bar is {threshold}). {ph.total.photos ? <>{ph.total.photos} photos in the range, average {ph.total.avgScore ?? '—'}, {pct(ph.total.usable, ph.total.photos)} usable.</> : 'No photos pulled in this range yet — photos are pulled when a finished job is considered for a post.'}</p>
      {ph.byTech.length > 0 && (
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-gray-500"><th className="py-1">Tech</th><th>Jobs</th><th>Photos</th><th>Average</th><th>Usable</th><th>Most common problem</th></tr></thead>
          <tbody>{ph.byTech.map(t => (
            <tr key={t.tech} className="border-t border-gray-100 text-gray-800">
              <td className="py-1">{t.tech}</td><td>{t.jobs}</td><td>{t.photos}</td>
              <td><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${t.avgScore == null ? 'bg-gray-100 text-gray-500' : t.avgScore >= threshold ? 'bg-green-100 text-green-800' : t.avgScore >= threshold - 20 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>{t.avgScore ?? '—'}</span></td>
              <td>{t.usableShare != null ? `${t.usableShare}%` : '—'}</td>
              <td className="text-xs text-gray-500">{t.topReasons.map(r => `${r.reason} (${r.count})`).join(', ') || '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  )
}
