'use client'

import { useId, useMemo, useState } from 'react'

// One small line chart used by the rank trend and the Google performance cards.
// Rules it follows (see the dataviz guidance): one y-axis, 2px round lines,
// >= 8px end markers with a 2px surface ring, hairline solid gridlines, a legend
// for two or more series plus direct end labels for up to four, a crosshair
// tooltip that lists every series at the hovered x, and a table view so nothing
// depends on color or hover alone. Colors are assigned to a series by its stable
// slot, never by its position after filtering.

export interface ChartSeries { key: string; label: string; slot: number; values: Array<number | null> }
export interface ChartMarker { index: number; label: string; kind: 'review' | 'post' }
interface Props {
  xLabels: string[]                      // one per index, e.g. week or day
  series: ChartSeries[]
  yInverted?: boolean                    // rank charts: 1 at the top
  yMin?: number; yMax?: number
  yFormat?: (v: number) => string
  height?: number
  markers?: ChartMarker[]
  emptyText?: string
}

// Reference categorical palette (light mode), validated in fixed order; see dataviz palette.md.
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
export const colorFor = (slot: number) => SERIES_COLORS[((slot % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length]
const SURFACE = '#ffffff'

export default function LineChart({ xLabels, series, yInverted = false, yMin, yMax, yFormat = v => String(v), height = 260, markers = [], emptyText = 'No data yet.' }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const uid = useId()
  const W = 720, H = height, padL = 44, padR = 16, padT = 12, padB = 40
  const n = xLabels.length
  const all = series.flatMap(s => s.values).filter((v): v is number => v != null)
  const lo = yMin ?? (all.length ? Math.min(...all) : 0), hi = yMax ?? (all.length ? Math.max(...all) : 1)
  const span = hi - lo || 1
  const x = (i: number) => n <= 1 ? padL + (W - padL - padR) / 2 : padL + (i / (n - 1)) * (W - padL - padR)
  const y = (v: number) => { const t = (v - lo) / span; return yInverted ? padT + t * (H - padT - padB) : H - padB - t * (H - padT - padB) }
  const ticks = useMemo(() => { const k = 4; return Array.from({ length: k + 1 }, (_, i) => lo + (span * i) / k) }, [lo, span])
  const paths = series.map(s => {
    let d = '', open = false
    s.values.forEach((v, i) => { if (v == null) { open = false; return } d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `; open = true })
    const lastIdx = s.values.map((v, i) => v == null ? -1 : i).filter(i => i >= 0).pop()
    return { s, d, lastIdx }
  })
  if (!n || !all.length) return <p className="text-sm text-gray-400">{emptyText}</p>
  const labelEvery = Math.max(1, Math.ceil(n / 8))
  const hoverX = hover != null ? x(hover) : null
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-1 text-xs text-gray-600">
        {series.length > 1 && series.map(s => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 rounded" style={{ background: colorFor(s.slot) }} />{s.label}</span>)}
        {markers.length > 0 && <span className="inline-flex items-center gap-1.5 text-gray-400"><span className="inline-block w-1.5 h-3 rounded-sm bg-gray-400" />review · <span className="inline-block w-1.5 h-3 rounded-sm bg-red-400" />post</span>}
        <button className="ml-auto underline text-gray-500" onClick={() => setTable(t => !t)}>{table ? 'chart' : 'table'}</button>
      </div>
      {table ? (
        <div className="overflow-x-auto"><table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="py-1 pr-2 font-medium">Period</th>{series.map(s => <th key={s.key} className="py-1 pr-2 font-medium">{s.label}</th>)}</tr></thead>
          <tbody>{xLabels.map((l, i) => <tr key={i} className="border-t border-gray-100 text-gray-800"><td className="py-1 pr-2">{l}</td>{series.map(s => <td key={s.key} className="py-1 pr-2">{s.values[i] == null ? '—' : yFormat(s.values[i]!)}</td>)}</tr>)}</tbody>
        </table></div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-labelledby={`${uid}-t`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={e => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; let best = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = Math.abs(x(i) - px); if (d < bd) { bd = d; best = i } } setHover(best) }}>
            <title id={`${uid}-t`}>{series.map(s => s.label).join(', ')}</title>
            {ticks.map((t, i) => <g key={i}><line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} /><text x={padL - 6} y={y(t) + 3} fontSize={10} textAnchor="end" fill="#6b7280">{yFormat(Math.round(t * 10) / 10)}</text></g>)}
            {xLabels.map((l, i) => i % labelEvery === 0 || i === n - 1 ? <text key={i} x={x(i)} y={H - padB + 14} fontSize={10} textAnchor="middle" fill="#6b7280">{l}</text> : null)}
            {markers.map((m, i) => <rect key={i} x={x(m.index) + (m.kind === 'post' ? 0.5 : -3.5)} y={H - padB + 20} width={3} height={10} rx={1} fill={m.kind === 'post' ? '#f87171' : '#9ca3af'}><title>{m.label}</title></rect>)}
            {hoverX != null && <line x1={hoverX} x2={hoverX} y1={padT} y2={H - padB} stroke="#9ca3af" strokeWidth={1} />}
            {paths.map(({ s, d, lastIdx }) => (
              <g key={s.key}>
                <path d={d} fill="none" stroke={colorFor(s.slot)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {lastIdx != null && lastIdx >= 0 && <circle cx={x(lastIdx)} cy={y(s.values[lastIdx]!)} r={4} fill={colorFor(s.slot)} stroke={SURFACE} strokeWidth={2} />}
                {series.length <= 4 && lastIdx != null && lastIdx >= 0 && <text x={x(lastIdx) + 7} y={y(s.values[lastIdx]!) + 3} fontSize={10} fill="#111827">{yFormat(s.values[lastIdx]!)}</text>}
                {hover != null && s.values[hover] != null && <circle cx={x(hover)} cy={y(s.values[hover]!)} r={4} fill={colorFor(s.slot)} stroke={SURFACE} strokeWidth={2} />}
              </g>
            ))}
          </svg>
          {hover != null && (
            <div className="pointer-events-none absolute top-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs shadow-sm" style={{ left: `${Math.min(92, Math.max(2, (hoverX! / W) * 100 + 1))}%` }}>
              <div className="text-gray-500 mb-0.5">{xLabels[hover]}</div>
              {series.map(s => <div key={s.key} className="flex items-center gap-1.5"><span className="inline-block w-3 h-0.5 rounded" style={{ background: colorFor(s.slot) }} /><b className="text-gray-900">{s.values[hover] == null ? '—' : yFormat(s.values[hover]!)}</b><span className="text-gray-500">{s.label}</span></div>)}
              {markers.filter(m => m.index === hover).map((m, i) => <div key={i} className="text-gray-500">{m.label}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
