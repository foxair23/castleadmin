'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import type { JobPhotoRow } from '@/lib/reputation/photos'
import {
  approvePostAction, skipPostAction, redraftPostAction, setPhotoUsableAction, preparePostsAction, testJobPhotosAction,
} from './reputation-actions'

// Reviews → Posts (PRD §5): the profile posts drafted from finished jobs. Each
// card shows the job, every photo we pulled from Service Fusion with its score,
// the chosen photo(s), the draft text and the button link. A person approves,
// edits, swaps photos, skips, or asks for a redraft with a note.

type PostStatus = 'draft' | 'approved' | 'scheduled' | 'published' | 'skipped' | 'failed'
interface PostRow {
  id: string; sf_job_id: string; status: PostStatus; photo_ids: string[]; draft_text: string; final_text: string | null
  cta_type: string; cta_url: string | null; guardrail_notes: Record<string, unknown>; model: string | null
  google_post_name: string | null; google_state: string | null; approved_by: string | null; approved_at: string | null
  scheduled_for: string | null; published_at: string | null; push_reasons: string[]; error: string | null; created_at: string
  job: { id: string; number: string | null; category: string | null; city: string | null; work_completed_at: string | null; description: string | null } | null
  photos: JobPhotoRow[]
}
type Filter = 'needs_approval' | 'scheduled' | 'published' | 'closed' | 'all'

interface Props { llmConfigured: boolean; photoMinScore: number; onNeedsApproval: (n: number) => void }

const input = 'border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 bg-white'
const btn = 'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50'
const btnGhost = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const card = 'rounded-lg border border-gray-200 bg-white p-4'
const PT = 'America/Los_Angeles'
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const fmtWhen = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: PT, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const ptToday = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return p // en-CA gives YYYY-MM-DD
}

const STATUS_LABEL: Record<PostStatus, string> = { draft: 'Needs approval', approved: 'Approved', scheduled: 'Scheduled', published: 'Published', skipped: 'Skipped', failed: 'Failed' }
const STATUS_CLASS: Record<PostStatus, string> = {
  draft: 'bg-amber-100 text-amber-800', approved: 'bg-blue-100 text-blue-800', scheduled: 'bg-blue-100 text-blue-800',
  published: 'bg-green-100 text-green-800', skipped: 'bg-gray-100 text-gray-600', failed: 'bg-red-100 text-red-800',
}
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'needs_approval', label: 'Needs approval' }, { key: 'scheduled', label: 'Scheduled' }, { key: 'published', label: 'Published' }, { key: 'closed', label: 'Skipped & failed' }, { key: 'all', label: 'All' },
]

export default function PostsTab({ llmConfigured, photoMinScore, onNeedsApproval }: Props) {
  const [filter, setFilter] = useState<Filter>('needs_approval')
  const [tick, setTick] = useState(0)
  const [data, setData] = useState<{ key: string; posts: PostRow[]; err: string | null } | null>(null)
  const key = `${filter}:${tick}`

  // Fetch on filter change or refresh; state is only set once the response is in.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/admin/reviews/posts?status=${filter}`)
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
        if (cancelled) return
        setData({ key, posts: j.posts ?? [], err: null })
        onNeedsApproval(j.needsApproval ?? 0)
      } catch (e) {
        if (!cancelled) setData({ key, posts: [], err: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [filter, key, onNeedsApproval])
  const loading = data?.key !== key
  const posts = data?.posts ?? []
  const err = data?.err ?? null
  const refresh = useCallback(() => setTick(t => t + 1), [])

  return (
    <div className="space-y-4">
      {!llmConfigured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <b>ANTHROPIC_API_KEY is not set.</b> Photos are not scored and no posts are drafted until it is.
        </div>
      )}
      <PrepareCard llmConfigured={llmConfigured} onDone={refresh} />
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} className={`px-3 py-1 text-sm rounded-full border ${filter === f.key ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>{f.label}</button>
        ))}
        <button className={`${btnGhost} ml-auto`} onClick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {!loading && posts.length === 0 && (
        <div className={`${card} text-sm text-gray-500`}>
          {filter === 'needs_approval' ? 'Nothing waiting. New drafts appear here each morning after the 6am pass, or when you run "Prepare posts" above.' : 'No posts here.'}
        </div>
      )}
      {posts.map(p => <PostCard key={p.id} post={p} threshold={photoMinScore} onChange={refresh} />)}
      <TestPhotosCard />
    </div>
  )
}

// ── Prepare posts by hand ───────────────────────────────────────────────────

function PrepareCard({ llmConfigured, onDone }: { llmConfigured: boolean; onDone: () => void }) {
  const [pending, start] = useTransition()
  const [mode, setMode] = useState<'day' | 'range'>('day')
  const [day, setDay] = useState(ptToday(-1))
  const [from, setFrom] = useState(ptToday(-7))
  const [to, setTo] = useState(ptToday(-1))
  const [msg, setMsg] = useState<string | null>(null)
  return (
    <div className={card}>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Prepare posts</h2>
          <p className="text-xs text-gray-500">Runs by itself every morning for yesterday&rsquo;s finished jobs. Use this to run it now, or to catch up on a range of days (a few jobs at a time).</p>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <button onClick={() => setMode('day')} className={`px-2 py-1 rounded border ${mode === 'day' ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'}`}>One day</button>
          <button onClick={() => setMode('range')} className={`px-2 py-1 rounded border ${mode === 'range' ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'}`}>Range</button>
        </div>
        {mode === 'day'
          ? <input type="date" className={input} value={day} onChange={e => setDay(e.target.value)} />
          : <><input type="date" className={input} value={from} onChange={e => setFrom(e.target.value)} /><span className="text-gray-400 text-sm">to</span><input type="date" className={input} value={to} onChange={e => setTo(e.target.value)} /></>}
        <button className={btn} disabled={pending || !llmConfigured} onClick={() => start(async () => {
          setMsg('Pulling photos, scoring and drafting… this can take a minute per job.')
          const r = await preparePostsAction(mode === 'day' ? { dateKey: day } : { from, to })
          if (r.error) { setMsg(r.error); return }
          const parts = [`${r.candidates ?? 0} finished job${r.candidates === 1 ? '' : 's'} looked at`, `${r.drafted ?? 0} drafted`]
          if (r.scheduled) parts.push(`${r.scheduled} scheduled by autopilot`)
          if (r.noPhoto) parts.push(`${r.noPhoto} without a usable photo`)
          if (r.skipped) parts.push(`${r.skipped} skipped`)
          if (r.reason === 'weekly_cap') parts.push('weekly cap reached')
          if (r.errors?.length) parts.push(`${r.errors.length} error${r.errors.length === 1 ? '' : 's'}: ${r.errors[0]}`)
          setMsg(parts.join(' · '))
          onDone()
        })}>{pending ? 'Working…' : 'Run now'}</button>
      </div>
      {msg && <p className="text-sm text-gray-600 mt-2">{msg}</p>}
    </div>
  )
}

// ── One post ────────────────────────────────────────────────────────────────

function PostCard({ post, threshold, onChange }: { post: PostRow; threshold: number; onChange: () => void }) {
  const [pending, start] = useTransition()
  const editable = post.status === 'draft'
  const [text, setText] = useState(post.final_text ?? post.draft_text)
  const [selected, setSelected] = useState<string[]>(post.photo_ids)
  const [note, setNote] = useState('')
  const [showRedraft, setShowRedraft] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const notes = post.guardrail_notes ?? {}
  const failures = (notes.failures as Array<{ check: string; detail: string }> | undefined) ?? []
  const modelNotes = notes.model_notes as string | null | undefined
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const dirtyPhotos = JSON.stringify(selected) !== JSON.stringify(post.photo_ids)
  const j = post.job

  function togglePhoto(p: JobPhotoRow) {
    if (!editable || !p.public_url) return
    setSelected(s => s.includes(p.id) ? s.filter(x => x !== p.id) : s.length >= 2 ? [s[1], p.id] : [...s, p.id])
  }
  const run = (fn: () => Promise<{ error?: string } & Record<string, unknown>>, ok?: (r: Record<string, unknown>) => string) => start(async () => {
    setErr(null); setMsg(null)
    const r = await fn()
    if (r.error) { setErr(r.error); return }
    if (ok) setMsg(ok(r))
    onChange()
  })

  return (
    <div className={`${card} ${editable ? 'border-amber-200' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm mb-3">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[post.status]}`}>{STATUS_LABEL[post.status]}</span>
        <span className="font-medium text-gray-900">{j?.category ?? 'Job'}{j?.city ? ` · ${j.city}` : ''}</span>
        <span className="text-gray-500">job {j?.number ?? post.sf_job_id} · finished {fmtDate(j?.work_completed_at ?? null)}</span>
        {post.status === 'draft' && post.approved_at && !post.approved_by && <span className="text-xs text-blue-700">pulled back from autopilot</span>}
        {(post.status === 'approved' || post.status === 'scheduled') && <span className="ml-auto text-xs text-blue-700">{post.approved_by ? 'approved' : 'autopilot'} · goes out {fmtWhen(post.scheduled_for)}{post.push_reasons?.length ? ` (${post.push_reasons.join(', ')})` : ''}</span>}
        {post.status === 'published' && <span className="ml-auto text-xs text-green-700">published {fmtWhen(post.published_at)}{post.google_state ? ` · ${post.google_state}` : ''}</span>}
        {post.status === 'failed' && <span className="ml-auto text-xs text-red-700">{post.error ?? 'failed'}</span>}
      </div>

      {j?.description && <p className="text-xs text-gray-500 mb-3 line-clamp-2">{j.description}</p>}

      <PhotoGrid photos={post.photos} selected={selected} editable={editable} threshold={threshold} onToggle={togglePhoto} onOverride={(id, v) => run(() => setPhotoUsableAction(id, v))} />

      <div className="mt-3">
        {editable
          ? <textarea className={`${input} w-full`} rows={5} value={text} onChange={e => setText(e.target.value)} />
          : <p className="text-sm text-gray-900 whitespace-pre-wrap rounded border border-gray-100 bg-gray-50 px-3 py-2">{post.final_text ?? post.draft_text}</p>}
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
          <span>{words} words{editable && (words < 15 || words > 45) ? ' · aim for 15–45' : ''}</span>
          {post.cta_url && <span>button: {post.cta_type === 'CALL' ? 'Call now' : 'Learn more'} → <a className="underline" href={post.cta_url} target="_blank" rel="noreferrer">{post.cta_url.replace(/^https?:\/\//, '')}</a></span>}
          {post.model && <span className="font-mono">{post.model}</span>}
        </div>
      </div>

      {(failures.length > 0 || modelNotes) && (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-1">
          {failures.map((f, i) => <p key={i}><b>{f.check}:</b> {f.detail}</p>)}
          {modelNotes && <p><b>Drafter says:</b> {modelNotes}</p>}
        </div>
      )}

      {editable && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn} disabled={pending || !text.trim() || selected.length === 0}
              onClick={() => run(() => approvePostAction(post.id, text, dirtyPhotos ? selected : undefined), r => `Scheduled for ${fmtWhen(r.scheduledFor as string)}`)}>
              {text.trim() !== post.draft_text.trim() ? 'Approve edited' : 'Approve'}
            </button>
            <button className={btnGhost} disabled={pending} onClick={() => setShowRedraft(v => !v)}>Redraft…</button>
            <button className={btnGhost} disabled={pending} onClick={() => { if (confirm('Skip this post? The job will not be posted.')) run(() => skipPostAction(post.id)) }}>Skip</button>
            {selected.length === 0 && <span className="text-xs text-red-600">Pick at least one photo.</span>}
            {selected.length > 0 && dirtyPhotos && <span className="text-xs text-gray-500">Photo choice changed — saved when you approve or redraft.</span>}
          </div>
          {showRedraft && (
            <div className="flex gap-2">
              <input className={`${input} flex-1`} placeholder="What should change? e.g. “mention the quieter opener”, “shorter”" value={note} onChange={e => setNote(e.target.value)} />
              <button className={btn} disabled={pending} onClick={() => run(() => redraftPostAction(post.id, note, dirtyPhotos ? selected : undefined), () => 'Redrafted.')}>{pending ? 'Drafting…' : 'Redraft'}</button>
            </div>
          )}
        </div>
      )}
      {(msg || err) && <p className={`mt-2 text-xs ${err ? 'text-red-600' : 'text-green-700'}`}>{err ?? msg}</p>}
    </div>
  )
}

// ── Photo grid ──────────────────────────────────────────────────────────────

const SHOWS_LABEL: Record<string, string> = { before: 'Before', after: 'After', finished: 'Finished work', other: 'Other' }

function PhotoGrid({ photos, selected, editable, threshold, onToggle, onOverride }: {
  photos: JobPhotoRow[]; selected: string[]; editable: boolean; threshold: number
  onToggle: (p: JobPhotoRow) => void; onOverride: (id: string, v: boolean | null) => void
}) {
  if (photos.length === 0) return <p className="text-xs text-gray-400">No photos found on this job in Service Fusion.</p>
  const pairIndex = new Map<string, number>()
  for (const p of photos) if (p.pair_id && !pairIndex.has(p.pair_id)) pairIndex.set(p.pair_id, pairIndex.size + 1)
  return (
    <div className="flex flex-wrap gap-3">
      {photos.map(p => {
        const idx = selected.indexOf(p.id)
        const usable = !!p.public_url && (p.override_usable ?? ((p.score ?? -1) >= threshold))
        const scoreClass = p.score == null ? 'bg-gray-200 text-gray-600' : p.score >= threshold ? 'bg-green-600 text-white' : p.score >= threshold - 20 ? 'bg-amber-500 text-white' : 'bg-red-600 text-white'
        return (
          <div key={p.id} className={`w-40 ${!usable && idx < 0 ? 'opacity-60' : ''}`}>
            <button type="button" onClick={() => onToggle(p)} disabled={!editable || !p.public_url} title={p.score_reasons?.join('\n') || undefined}
              className={`relative block w-40 h-28 rounded overflow-hidden bg-gray-100 border-2 ${idx >= 0 ? 'border-red-600 ring-2 ring-red-200' : 'border-transparent'} ${editable && p.public_url ? 'cursor-pointer' : 'cursor-default'}`}>
              {p.public_url
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={p.public_url} alt={p.subject ?? ''} className="w-full h-full object-cover" loading="lazy" />
                : <span className="flex h-full items-center justify-center text-xs text-gray-400 px-2 text-center">{p.error ? 'could not fetch' : 'not imported'}</span>}
              <span className={`absolute top-1 left-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ${scoreClass}`}>{p.score ?? '?'}</span>
              {idx >= 0 && <span className="absolute top-1 right-1 rounded-full bg-red-600 text-white text-[11px] font-semibold w-5 h-5 flex items-center justify-center">{idx + 1}</span>}
              {p.override_usable != null && <span className="absolute bottom-1 right-1 rounded bg-gray-900/80 text-white text-[10px] px-1">{p.override_usable ? 'forced ok' : 'blocked'}</span>}
            </button>
            <div className="mt-1 text-[11px] leading-tight text-gray-600">
              <span className="font-medium text-gray-800">{p.shows ? SHOWS_LABEL[p.shows] : 'Unscored'}</span>
              {p.pair_id && pairIndex.has(p.pair_id) && <span className="text-gray-400"> · pair {pairIndex.get(p.pair_id)}</span>}
              {p.subject && <span className="block truncate" title={p.subject}>{p.subject}</span>}
              {p.score_reasons?.length > 0 && <span className="block text-gray-400 truncate" title={p.score_reasons.join('; ')}>{p.score_reasons[0]}</span>}
            </div>
            {editable && p.public_url && (
              <div className="mt-1 flex gap-1 text-[10px]">
                {p.override_usable !== true && <button className="underline text-gray-500" onClick={() => onOverride(p.id, true)}>allow</button>}
                {p.override_usable !== false && <button className="underline text-gray-500" onClick={() => onOverride(p.id, false)}>block</button>}
                {p.override_usable != null && <button className="underline text-gray-500" onClick={() => onOverride(p.id, null)}>reset</button>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Diagnostic: what does Service Fusion give us for a job? ─────────────────

function TestPhotosCard() {
  const [pending, start] = useTransition()
  const [ref, setRef] = useState('')
  const [out, setOut] = useState<Awaited<ReturnType<typeof testJobPhotosAction>> | null>(null)
  return (
    <details className={card}>
      <summary className="text-sm font-semibold text-gray-900 cursor-pointer">Check a job&rsquo;s photos</summary>
      <p className="text-xs text-gray-500 mt-1 mb-2">Enter a Service Fusion job number to see exactly which pictures the API returns for it and pull them in. Useful for confirming the photo feed works before trusting the daily pass.</p>
      <div className="flex gap-2 max-w-md">
        <input className={`${input} flex-1`} placeholder="Job number or id" value={ref} onChange={e => setRef(e.target.value)} />
        <button className={btnGhost} disabled={pending || !ref.trim()} onClick={() => start(async () => setOut(await testJobPhotosAction(ref)))}>{pending ? 'Checking…' : 'Check'}</button>
      </div>
      {out && (
        <div className="mt-3 text-xs text-gray-700 space-y-1">
          {out.error ? <p className="text-red-600">{out.error}</p> : (
            <>
              <p>{out.found} picture{out.found === 1 ? '' : 's'} on the job · {out.imported} imported now{out.importErrors?.length ? ` · ${out.importErrors.length} failed` : ''}</p>
              {out.rawKeys && out.rawKeys.length > 0 && <p className="text-gray-400">picture-like fields on the job: {out.rawKeys.join(', ')}</p>}
              {out.rawKeys && out.rawKeys.length === 0 && <p className="text-amber-700">The job payload has no picture fields at all. Service Fusion may need the pictures expand enabled on the API key.</p>}
              <ul className="list-disc pl-4">
                {out.pictures?.map((p, i) => <li key={i}>{p.name ?? '(no name)'}{p.docType ? ` · ${p.docType}` : ''} · <a className="underline" href={p.url} target="_blank" rel="noreferrer">open</a></li>)}
              </ul>
              {out.importErrors?.map((e, i) => <p key={i} className="text-red-600">{e}</p>)}
            </>
          )}
        </div>
      )}
    </details>
  )
}
