'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import type { MonitorOverview, ScanDetail, PlaceRow, ScanRow } from '@/lib/rank/scorecard'
import type { ScorecardRow, Competitor } from '@/lib/rank/summary'
import { bandFor, COST_PER_REQUEST_USD, type RankBand } from '@/lib/rank/grid'
import {
  addPlaceAction, updatePlaceAction, removePlaceAction, addMonitorsAction, addStarterMonitorsAction, setMonitorActiveAction, removeMonitorAction,
  scanMonitorNowAction, liveCheckAction, monitorFromScanAction, upsertAreaPageAction, rankProviderStatusAction,
} from './reputation-actions'

// Reviews → Rankings (PRD §8): the monitored keyword × place list with
// week-over-week movement, a Check-now form, the grid view of one scan with
// the competitor table, and the neighborhood scorecard with what to do next.

interface Overview { configured: boolean; weekKey: string; overview: MonitorOverview[]; scorecard: ScorecardRow[]; liveScans: Array<ScanRow & { place_name: string | null }>; places: PlaceRow[]; areaPages: Array<{ place_id: string; url: string; notes: string | null; page_updated_at: string | null }> }
interface Props { defaultKeywords: string[]; businessMatch: string; weeklyCap: number }

const card = 'rounded-lg border border-gray-200 bg-white p-4'
const input = 'border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 bg-white'
const btn = 'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50'
const btnGhost = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50'
const link = 'text-xs text-gray-500 underline hover:text-gray-800 disabled:opacity-50'
const PT = 'America/Los_Angeles'
const fmtWhen = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const money = (n: number) => `$${n.toFixed(2)}`
const BAND_CLASS: Record<RankBand, string> = { top3: 'bg-green-500 text-white', top10: 'bg-amber-400 text-gray-900', top20: 'bg-red-500 text-white', none: 'bg-gray-300 text-gray-700' }

export default function RankingsTab({ defaultKeywords, businessMatch, weeklyCap }: Props) {
  const [tick, setTick] = useState(0)
  const [data, setData] = useState<{ tick: number; d: Overview | null; err: string | null } | null>(null)
  const [openScan, setOpenScan] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/admin/reviews/rankings')
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
        if (!cancelled) setData({ tick, d: j, err: null })
      } catch (e) { if (!cancelled) setData({ tick, d: null, err: e instanceof Error ? e.message : String(e) }) }
    })()
    return () => { cancelled = true }
  }, [tick])
  const refresh = useCallback(() => setTick(t => t + 1), [])
  const loading = data?.tick !== tick
  const d = data?.d ?? null

  return (
    <div className="space-y-4">
      {d && !d.configured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <b>Rank data provider is not connected.</b> Add <code>DATAFORSEO_LOGIN</code> and <code>DATAFORSEO_PASSWORD</code> to the app&rsquo;s environment (DataForSEO account, about $0.002 per search, $50 minimum deposit). Until then you can build the monitored list, but nothing is scanned.
        </div>
      )}
      {data?.err && <p className="text-sm text-red-600">{data.err}</p>}
      <CheckNowCard places={d?.places ?? []} defaultKeywords={defaultKeywords} configured={!!d?.configured} onDone={refresh} onOpen={setOpenScan} />
      <MonitoredCard d={d} loading={loading} defaultKeywords={defaultKeywords} weeklyCap={weeklyCap} businessMatch={businessMatch} onChange={refresh} onOpen={setOpenScan} />
      <ScorecardCard rows={d?.scorecard ?? []} areaPages={d?.areaPages ?? []} onChange={refresh} />
      <CompetitorsCard keywords={[...new Set((d?.overview ?? []).map(m => m.keyword))]} />
      <LiveHistoryCard scans={d?.liveScans ?? []} onOpen={setOpenScan} onChange={refresh} />
      <PlacesCard places={d?.places ?? []} onChange={refresh} />
      {openScan && <ScanModal scanId={openScan} onClose={() => setOpenScan(null)} />}
    </div>
  )
}

// ── Check now ───────────────────────────────────────────────────────────────

function CheckNowCard({ places, defaultKeywords, configured, onDone, onOpen }: { places: PlaceRow[]; defaultKeywords: string[]; configured: boolean; onDone: () => void; onOpen: (id: string) => void }) {
  const [pending, start] = useTransition()
  const [keyword, setKeyword] = useState(defaultKeywords[0] ?? 'garage door repair')
  const [placeId, setPlaceId] = useState('')
  const [location, setLocation] = useState('')
  const [grid, setGrid] = useState(1)
  const [out, setOut] = useState<Awaited<ReturnType<typeof liveCheckAction>> | null>(null)
  const requests = grid * grid
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Check now</h2>
      <p className="text-xs text-gray-500 mb-3">Where does Castle show in the Map Pack for a search made from a spot? Pick a monitored place or type any city, ZIP, address or &ldquo;lat, lng&rdquo;. Results are saved so you can compare later.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-600">Keyword<br /><input list="rank-kw" className={`${input} w-56`} value={keyword} onChange={e => setKeyword(e.target.value)} /></label>
        <datalist id="rank-kw">{defaultKeywords.map(k => <option key={k} value={k} />)}</datalist>
        <label className="text-xs text-gray-600">Monitored place<br />
          <select className={`${input} w-44`} value={placeId} onChange={e => setPlaceId(e.target.value)}><option value="">— type a location —</option>{places.filter(p => p.is_active).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {!placeId && <label className="text-xs text-gray-600">Location<br /><input className={`${input} w-56`} placeholder="Vista, CA · 92084 · 33.12, -117.08" value={location} onChange={e => setLocation(e.target.value)} /></label>}
        <label className="text-xs text-gray-600">Grid<br />
          <select className={`${input} w-36`} value={grid} onChange={e => setGrid(Number(e.target.value))}><option value={1}>Single point</option><option value={3}>3×3 (1 mi apart)</option><option value={5}>5×5</option><option value={7}>7×7</option></select></label>
        <button className={btn} disabled={pending || !configured || !keyword.trim() || (!placeId && !location.trim())} onClick={() => start(async () => {
          setOut(null)
          const r = await liveCheckAction({ keyword, location, gridSize: grid, placeId: placeId || null })
          setOut(r); if (!r.error) onDone()
        })}>{pending ? 'Checking…' : `Check (${requests} search${requests === 1 ? '' : 'es'}, ~${money(requests * COST_PER_REQUEST_USD)})`}</button>
      </div>
      {out && (
        <div className={`mt-3 text-sm ${out.error ? 'text-red-600' : 'text-gray-800'}`}>
          {out.error ? out.error : (
            <span>
              <b>{out.label}</b> · {out.avgRank != null ? `average position ${out.avgRank}` : 'not in the top 20'}{grid > 1 ? ` · seen at ${Math.round((out.foundShare ?? 0) * 100)}% of points` : ''} · {out.requests} search{out.requests === 1 ? '' : 'es'}, {money(out.cost ?? 0)}
              {' '}<button className={link} onClick={() => onOpen(out.scanId!)}>open</button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Monitored list ──────────────────────────────────────────────────────────

function MonitoredCard({ d, loading, defaultKeywords, weeklyCap, businessMatch, onChange, onOpen }: { d: Overview | null; loading: boolean; defaultKeywords: string[]; weeklyCap: number; businessMatch: string; onChange: () => void; onOpen: (id: string) => void }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [placeId, setPlaceId] = useState('')
  const [kws, setKws] = useState<string[]>(defaultKeywords.slice(0, 2))
  const [extra, setExtra] = useState('')
  const [grid, setGrid] = useState(3)
  const [showAdd, setShowAdd] = useState(false)
  const monitors = d?.overview ?? []
  const active = monitors.filter(m => m.is_active && m.place?.is_active)
  const weeklyRequests = active.reduce((s, m) => s + m.grid_size * m.grid_size, 0)
  const scannedThisWeek = active.filter(m => m.latest?.week_key === d?.weekKey).length
  const run = (fn: () => Promise<{ error?: string }>, ok?: string) => start(async () => { setMsg(null); const r = await fn(); setMsg(r.error ?? ok ?? null); if (!r.error) onChange() })
  const byPlace = new Map<string, MonitorOverview[]>()
  for (const m of monitors) byPlace.set(m.place?.name ?? '?', [...(byPlace.get(m.place?.name ?? '?') ?? []), m])
  const toggleKw = (k: string) => setKws(x => x.includes(k) ? x.filter(a => a !== k) : [...x, k])

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <h2 className="text-sm font-semibold text-gray-900">Monitored searches</h2>
        <span className="text-xs text-gray-500">{active.length} active · {weeklyRequests} searches a week (~{money(weeklyRequests * COST_PER_REQUEST_USD)}){weeklyRequests > weeklyCap ? ` · over the weekly cap of ${weeklyCap}` : ''} · {scannedThisWeek} scanned this week</span>
        <button className={`${btnGhost} ml-auto`} onClick={() => setShowAdd(v => !v)}>Add</button>
        {monitors.length === 0 && <button className={btn} disabled={pending} onClick={() => { if (confirm(`Add every starter place × ${defaultKeywords.length} default keywords as 3×3 grids? That is about ${money(15 * defaultKeywords.length * 9 * COST_PER_REQUEST_USD)} a week.`)) run(() => addStarterMonitorsAction(), 'Starter list added.') }}>Add starter list</button>}
      </div>
      <p className="text-xs text-gray-500 mb-3">Each row is one keyword searched from one place every Monday. Green is top 3, amber 4–10, red 11–20, grey not in the top 20. Castle is matched in results by &ldquo;{businessMatch}&rdquo; (Settings).</p>
      {showAdd && (
        <div className="rounded border border-gray-200 bg-gray-50 p-3 mb-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-gray-600">Place<br /><select className={`${input} w-44`} value={placeId} onChange={e => setPlaceId(e.target.value)}><option value="">choose…</option>{(d?.places ?? []).filter(p => p.is_active).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="text-xs text-gray-600">Grid<br /><select className={`${input} w-40`} value={grid} onChange={e => setGrid(Number(e.target.value))}><option value={1}>Single point</option><option value={3}>3×3 mini-grid</option><option value={5}>5×5</option><option value={7}>7×7 (heat map)</option><option value={9}>9×9 (heat map)</option></select></label>
            <label className="text-xs text-gray-600">Other keywords<br /><input className={`${input} w-64`} placeholder="comma separated" value={extra} onChange={e => setExtra(e.target.value)} /></label>
            <button className={btn} disabled={pending || !placeId || (kws.length === 0 && !extra.trim())} onClick={() => run(() => addMonitorsAction({ placeId, keywords: [...kws, ...extra.split(',')], gridSize: grid }), 'Added.')}>Add to list</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {defaultKeywords.map(k => <button key={k} onClick={() => toggleKw(k)} className={`rounded-full border px-2.5 py-0.5 text-xs ${kws.includes(k) ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'}`}>{k}</button>)}
          </div>
        </div>
      )}
      {msg && <p className="text-xs text-gray-600 mb-2">{msg}</p>}
      {loading && monitors.length === 0 && <p className="text-sm text-gray-400">Loading…</p>}
      {!loading && monitors.length === 0 && <p className="text-sm text-gray-400">Nothing monitored yet. Use &ldquo;Add starter list&rdquo; for the fifteen service-area cities, or add one place and keyword at a time.</p>}
      {[...byPlace].map(([place, rows]) => (
        <div key={place} className="mt-3">
          <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">{place}</h3>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-gray-500"><th className="py-1 font-medium">Keyword</th><th className="font-medium">Grid</th><th className="font-medium">Position</th><th className="font-medium">Change</th><th className="font-medium">Seen at</th><th className="font-medium">Top 3 at</th><th className="font-medium">Last scan</th><th className="font-medium">Trend</th><th></th></tr></thead>
            <tbody>{rows.map(m => {
              const l = m.latest
              return (
                <tr key={m.id} className={`border-t border-gray-100 ${m.is_active ? 'text-gray-800' : 'text-gray-400'}`}>
                  <td className="py-1.5">{m.keyword}{!m.is_active && <span className="ml-1 text-[10px]">(paused)</span>}</td>
                  <td>{m.grid_size === 1 ? 'point' : `${m.grid_size}×${m.grid_size}`}</td>
                  <td><RankPill rank={l?.our_rank_avg ?? null} unknown={!l} /></td>
                  <td><Delta d={m.delta} /></td>
                  <td>{l?.found_share != null ? `${Math.round(l.found_share * 100)}%` : '—'}</td>
                  <td>{l?.top3_share != null ? `${Math.round(l.top3_share * 100)}%` : '—'}</td>
                  <td className="text-xs text-gray-500">{fmtWhen(l?.run_at)}</td>
                  <td><Spark history={m.history} /></td>
                  <td className="text-right whitespace-nowrap space-x-2">
                    {l && <button className={link} onClick={() => onOpen(l.id)}>view</button>}
                    <button className={link} disabled={pending || !d?.configured} onClick={() => run(() => scanMonitorNowAction(m.id), 'Scanned.')}>scan now</button>
                    <button className={link} disabled={pending} onClick={() => run(() => setMonitorActiveAction(m.id, !m.is_active))}>{m.is_active ? 'pause' : 'resume'}</button>
                    <button className={link} disabled={pending} onClick={() => { if (confirm('Remove this keyword from the monitored list? Past scans are kept.')) run(() => removeMonitorAction(m.id)) }}>remove</button>
                  </td>
                </tr>
              )
            })}</tbody>
          </table></div>
        </div>
      ))}
    </div>
  )
}

function RankPill({ rank, unknown }: { rank: number | null; unknown?: boolean }) {
  if (unknown) return <span className="text-xs text-gray-400">not scanned</span>
  const r = rank == null ? null : Math.round(rank)
  return <span className={`inline-block min-w-[2rem] text-center rounded px-1.5 py-0.5 text-xs font-semibold ${BAND_CLASS[bandFor(r)]}`}>{rank == null ? '20+' : rank % 1 === 0 ? rank : rank.toFixed(1)}</span>
}
function Delta({ d }: { d: number | null }) {
  if (d == null || d === 0) return <span className="text-xs text-gray-400">{d === 0 ? '—' : ''}</span>
  return <span className={`text-xs font-medium ${d > 0 ? 'text-green-700' : 'text-red-700'}`}>{d > 0 ? '▲' : '▼'} {Math.abs(d)}</span>
}
function Spark({ history }: { history: MonitorOverview['history'] }) {
  if (history.length < 2) return null
  const pts = history.map(h => h.our_rank_avg ?? 21)
  const w = 60, h = 18
  const path = pts.map((p, i) => `${(i / (pts.length - 1)) * w},${((p - 1) / 20) * (h - 2) + 1}`).join(' ')
  return <svg width={w} height={h} className="text-gray-500"><polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={path} /></svg>
}

// ── Scan detail modal ───────────────────────────────────────────────────────

function ScanModal({ scanId, onClose }: { scanId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ScanDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/admin/reviews/rankings/scan?id=${scanId}`).then(async res => { const j = await res.json(); if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`); if (!cancelled) setDetail(j) }).catch(e => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [scanId])
  const s = detail?.scan
  const n = s?.grid_size ?? 1
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{s ? `“${s.keyword}”` : 'Scan'}</h2>
            {s && <p className="text-xs text-gray-500">{s.source === 'live' ? 'Live check' : 'Weekly scan'} · {fmtWhen(s.run_at)} · {n === 1 ? 'single point' : `${n}×${n} grid, ${s.spacing_miles} mi apart`} · {s.requests} searches, {money(s.cost_usd ?? 0)}{detail?.previous ? ` · compared to ${fmtWhen(detail.previous.run_at)}` : ''}</p>}
          </div>
          <button className={`${btnGhost} ml-auto`} onClick={onClose}>Close</button>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {!detail && !err && <p className="text-sm text-gray-400">Loading…</p>}
        {detail && (
          <div className="grid md:grid-cols-[auto_1fr] gap-5">
            <div>
              <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
                {detail.points.map(p => (
                  <a key={`${p.row}-${p.col}`} href={`https://www.google.com/maps/search/${encodeURIComponent(s!.keyword)}/@${p.lat},${p.lng},14z`} target="_blank" rel="noreferrer" title={p.error ?? `${p.lat}, ${p.lng}${p.previous != null ? ` · was ${p.previous}` : ''}`}
                    className={`relative flex flex-col items-center justify-center rounded ${n === 1 ? 'w-24 h-24' : n <= 3 ? 'w-16 h-16' : 'w-10 h-10'} ${p.error ? 'bg-gray-100 text-gray-400' : BAND_CLASS[p.band]}`}>
                    <span className={`font-bold ${n >= 5 ? 'text-xs' : 'text-lg'}`}>{p.error ? '!' : p.our_rank ?? '—'}</span>
                    {p.delta != null && p.delta !== 0 && n <= 5 && <span className="text-[10px] leading-none">{p.delta > 0 ? '▲' : '▼'}{Math.abs(p.delta)}</span>}
                  </a>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">Click a square to open that spot on Google Maps. North is up.</p>
              {s?.source === 'live' && !s.monitor_id && (
                <div className="mt-3 flex gap-2">
                  <input className={`${input} w-40`} placeholder="Place name" value={name} onChange={e => setName(e.target.value)} />
                  <button className={btnGhost} disabled={pending || !name.trim()} onClick={() => start(async () => { const r = await monitorFromScanAction(scanId, name); setMsg(r.error ?? 'Added to the monitored list. It will be scanned every Monday.') })}>Monitor this</button>
                </div>
              )}
              {msg && <p className="text-xs text-gray-600 mt-1">{msg}</p>}
            </div>
            <div>
              <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Who holds the spots</h3>
              <CompetitorTable rows={detail.competitors} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function CompetitorTable({ rows }: { rows: Competitor[] }) {
  if (!rows.length) return <p className="text-sm text-gray-400">No results stored.</p>
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs text-gray-500"><th className="py-1 font-medium">Business</th><th className="font-medium">Rating</th><th className="font-medium">Reviews</th><th className="font-medium">Avg position</th><th className="font-medium">Top-3 at</th></tr></thead>
      <tbody>{rows.map(c => (
        <tr key={c.key} className={`border-t border-gray-100 ${c.is_us ? 'bg-green-50 font-medium text-gray-900' : 'text-gray-800'}`}>
          <td className="py-1">{c.title}{c.is_us && <span className="ml-1 text-[10px] text-green-700">us</span>}</td><td>{c.rating ?? '—'}</td><td>{c.reviews ?? '—'}</td><td>{c.avgRank}</td><td>{c.top3} of {c.points}</td>
        </tr>
      ))}</tbody>
    </table>
  )
}

// ── Competitors by keyword ──────────────────────────────────────────────────

function CompetitorsCard({ keywords }: { keywords: string[] }) {
  const [kw, setKw] = useState('')
  const [out, setOut] = useState<{ kw: string; competitors: Competitor[]; scans: number } | null>(null)
  const chosen = kw || keywords[0] || ''
  useEffect(() => {
    if (!chosen) return
    let cancelled = false
    fetch(`/api/admin/reviews/rankings/competitors?keyword=${encodeURIComponent(chosen)}`).then(r => r.json()).then(j => { if (!cancelled) setOut({ kw: chosen, competitors: j.competitors ?? [], scans: j.scans ?? 0 }) }).catch(() => {})
    return () => { cancelled = true }
  }, [chosen])
  if (!keywords.length) return null
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h2 className="text-sm font-semibold text-gray-900">Competitor benchmark</h2>
        <select className={`${input} w-56`} value={chosen} onChange={e => setKw(e.target.value)}>{keywords.map(k => <option key={k} value={k}>{k}</option>)}</select>
        {out && out.kw === chosen && <span className="text-xs text-gray-500">across the latest scan of {out.scans} place{out.scans === 1 ? '' : 's'}</span>}
      </div>
      <p className="text-xs text-gray-500 mb-2">Who holds the top three most often, with their rating and review count. The gap in review count is usually the story.</p>
      {out && out.kw === chosen ? <CompetitorTable rows={out.competitors} /> : <p className="text-sm text-gray-400">Loading…</p>}
    </div>
  )
}

// ── Neighborhood scorecard ──────────────────────────────────────────────────

const STATUS_CLASS = { good: 'bg-green-100 text-green-800', watch: 'bg-amber-100 text-amber-800', act: 'bg-red-100 text-red-800' }

function ScorecardCard({ rows, areaPages, onChange }: { rows: ScorecardRow[]; areaPages: Overview['areaPages']; onChange: () => void }) {
  const [pending, start] = useTransition()
  const [edit, setEdit] = useState<{ placeId: string; url: string; date: string } | null>(null)
  if (!rows.length) return null
  const pageFor = (id: string) => areaPages.find(p => p.place_id === id)
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Neighborhood scorecard</h2>
      <p className="text-xs text-gray-500 mb-3">One row per place: rank, the work done there in the last 90 days (by ZIP), the reviews that came from it, how well they were answered, the website page for that area, and the one thing to do next.</p>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-gray-500"><th className="py-1 font-medium">Place</th><th className="font-medium">Position</th><th className="font-medium">4-wk</th><th className="font-medium">Jobs 90d</th><th className="font-medium">Reviews 90d</th><th className="font-medium">Replied</th><th className="font-medium">Area page</th><th className="font-medium">Top competitor</th><th className="font-medium">What to do</th></tr></thead>
        <tbody>{rows.map(r => {
          const page = pageFor(r.place.id)
          const editing = edit?.placeId === r.place.id
          return (
            <tr key={r.place.id} className="border-t border-gray-100 text-gray-800 align-top">
              <td className="py-2 font-medium">{r.place.name}<div className="text-[10px] text-gray-400">{r.place.zips.join(' ') || 'no ZIPs set'}</div></td>
              <td className="py-2"><RankPill rank={r.rankNow} unknown={r.keywords.length === 0} /></td>
              <td className="py-2"><Delta d={r.trend} /></td>
              <td className="py-2">{r.jobs90}</td>
              <td className="py-2">{r.reviews90}{r.reviewsAvg != null ? <span className="text-xs text-gray-400"> · {r.reviewsAvg}★</span> : null}</td>
              <td className="py-2">{r.replies.total ? `${r.replies.replied}/${r.replies.total}` : '—'}{r.replies.total ? <span className="text-xs text-gray-400"> · {r.replies.within48h} in 48h</span> : null}</td>
              <td className="py-2 text-xs">
                {editing ? (
                  <div className="space-y-1">
                    <input className={`${input} w-52`} placeholder="https://castlegarage.com/…" value={edit.url} onChange={e => setEdit({ ...edit, url: e.target.value })} />
                    <input type="date" className={`${input} w-40`} value={edit.date} onChange={e => setEdit({ ...edit, date: e.target.value })} />
                    <div className="space-x-2"><button className={link} disabled={pending} onClick={() => start(async () => { await upsertAreaPageAction({ placeId: r.place.id, url: edit.url, pageUpdatedAt: edit.date || null }); setEdit(null); onChange() })}>save</button><button className={link} onClick={() => setEdit(null)}>cancel</button></div>
                  </div>
                ) : page ? <><a className="underline" href={page.url} target="_blank" rel="noreferrer">page</a>{page.page_updated_at ? <span className="text-gray-400"> · updated {page.page_updated_at}</span> : null} <button className={link} onClick={() => setEdit({ placeId: r.place.id, url: page.url, date: page.page_updated_at ?? '' })}>edit</button></>
                  : <button className={link} onClick={() => setEdit({ placeId: r.place.id, url: '', date: '' })}>add</button>}
              </td>
              <td className="py-2 text-xs">{r.topCompetitor ? `${r.topCompetitor.title}${r.topCompetitor.rating != null ? ` · ${r.topCompetitor.rating}★` : ''}${r.topCompetitor.reviews != null ? ` (${r.topCompetitor.reviews})` : ''}` : '—'}</td>
              <td className="py-2 text-xs max-w-xs"><span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase mr-1 ${STATUS_CLASS[r.status]}`}>{r.status}</span>{r.advice}</td>
            </tr>
          )
        })}</tbody>
      </table></div>
    </div>
  )
}

// ── Live history and places ─────────────────────────────────────────────────

function LiveHistoryCard({ scans, onOpen, onChange }: { scans: Overview['liveScans']; onOpen: (id: string) => void; onChange: () => void }) {
  void onChange
  if (!scans.length) return null
  return (
    <details className={card}>
      <summary className="text-sm font-semibold text-gray-900 cursor-pointer">Past checks ({scans.length})</summary>
      <table className="w-full text-sm mt-2">
        <thead><tr className="text-left text-xs text-gray-500"><th className="py-1 font-medium">When</th><th className="font-medium">Keyword</th><th className="font-medium">Where</th><th className="font-medium">Grid</th><th className="font-medium">Position</th><th></th></tr></thead>
        <tbody>{scans.map(s => (
          <tr key={s.id} className="border-t border-gray-100 text-gray-800">
            <td className="py-1 text-xs text-gray-500">{fmtWhen(s.run_at)}</td><td>{s.keyword}</td><td className="text-xs">{s.place_name ?? `${s.center_lat.toFixed(4)}, ${s.center_lng.toFixed(4)}`}</td><td>{s.grid_size === 1 ? 'point' : `${s.grid_size}×${s.grid_size}`}</td>
            <td>{s.status === 'done' ? <RankPill rank={s.our_rank_avg} /> : <span className="text-xs text-red-600">{s.error ?? s.status}</span>}</td>
            <td className="text-right"><button className={link} onClick={() => onOpen(s.id)}>view</button></td>
          </tr>
        ))}</tbody>
      </table>
    </details>
  )
}

function PlacesCard({ places, onChange }: { places: PlaceRow[]; onChange: () => void }) {
  const [pending, start] = useTransition()
  const [f, setF] = useState({ name: '', query: '', zips: '' })
  const [msg, setMsg] = useState<string | null>(null)
  const [zipEdit, setZipEdit] = useState<{ id: string; zips: string } | null>(null)
  const [status, setStatus] = useState<{ configured: boolean; balance: number | null } | null>(null)
  const run = (fn: () => Promise<{ error?: string }>, ok?: string) => start(async () => { setMsg(null); const r = await fn(); setMsg(r.error ?? ok ?? null); if (!r.error) onChange() })
  return (
    <details className={card}>
      <summary className="text-sm font-semibold text-gray-900 cursor-pointer">Places ({places.filter(p => p.is_active).length} active)</summary>
      <p className="text-xs text-gray-500 mt-1 mb-2">A place is a city, ZIP or pin that searches run from. Its ZIP list decides which jobs and reviews count as &ldquo;here&rdquo; on the scorecard.</p>
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <label className="text-xs text-gray-600">Name<br /><input className={`${input} w-40`} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
        <label className="text-xs text-gray-600">Where (optional)<br /><input className={`${input} w-52`} placeholder="City, CA · ZIP · lat, lng" value={f.query} onChange={e => setF({ ...f, query: e.target.value })} /></label>
        <label className="text-xs text-gray-600">ZIPs<br /><input className={`${input} w-52`} placeholder="92084 92083" value={f.zips} onChange={e => setF({ ...f, zips: e.target.value })} /></label>
        <button className={btnGhost} disabled={pending || !f.name.trim()} onClick={() => run(() => addPlaceAction({ name: f.name, query: f.query, zips: f.zips }), 'Place added.')}>Add place</button>
        <button className={link} disabled={pending} onClick={() => start(async () => { const r = await rankProviderStatusAction(); if (!r.error) setStatus({ configured: !!r.configured, balance: r.balance ?? null }) })}>check provider balance</button>
        {status && <span className="text-xs text-gray-600">{status.configured ? `Provider connected${status.balance != null ? ` · balance $${status.balance.toFixed(2)}` : ''}` : 'Provider not connected'}</span>}
      </div>
      {msg && <p className="text-xs text-gray-600 mb-2">{msg}</p>}
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-gray-500"><th className="py-1 font-medium">Place</th><th className="font-medium">Center</th><th className="font-medium">ZIPs</th><th></th></tr></thead>
        <tbody>{places.map(p => (
          <tr key={p.id} className={`border-t border-gray-100 ${p.is_active ? 'text-gray-800' : 'text-gray-400'}`}>
            <td className="py-1">{p.name}{!p.is_active && <span className="ml-1 text-[10px]">(off)</span>}</td>
            <td className="text-xs">{p.lat.toFixed(4)}, {p.lng.toFixed(4)}</td>
            <td className="text-xs">{zipEdit?.id === p.id ? <span className="space-x-1"><input className={`${input} w-56`} value={zipEdit.zips} onChange={e => setZipEdit({ id: p.id, zips: e.target.value })} /><button className={link} disabled={pending} onClick={() => { run(() => updatePlaceAction(p.id, { zips: zipEdit.zips })); setZipEdit(null) }}>save</button></span> : <>{p.zips.join(' ') || '—'} <button className={link} onClick={() => setZipEdit({ id: p.id, zips: p.zips.join(' ') })}>edit</button></>}</td>
            <td className="text-right whitespace-nowrap space-x-2">
              <button className={link} disabled={pending} onClick={() => run(() => updatePlaceAction(p.id, { is_active: !p.is_active }))}>{p.is_active ? 'turn off' : 'turn on'}</button>
              <button className={link} disabled={pending} onClick={() => { if (confirm(`Remove ${p.name} and its monitored searches?`)) run(() => removePlaceAction(p.id)) }}>remove</button>
            </td>
          </tr>
        ))}</tbody>
      </table>
    </details>
  )
}
