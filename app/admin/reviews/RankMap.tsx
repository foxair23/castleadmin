'use client'

import { useEffect, useRef } from 'react'
import type { Map as LeafletMap, LayerGroup } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { RankBand } from '@/lib/rank/grid'

// Map Pack results drawn on a real map (PRD §8.4): numbered teardrop pins,
// green for top 3, amber 4–10, red 11–20, grey when not in the top 20, plus a
// red "us" pin for Castle's own listing where its coordinates are known.
// Leaflet with OpenStreetMap tiles: no key, no cost. Loaded only in the
// browser (Leaflet touches `window` on import).

export interface MapPin {
  id: string; lat: number; lng: number
  kind: 'rank' | 'us' | 'center'
  label?: string            // number shown inside a rank pin
  band?: RankBand
  delta?: number | null     // movement since the previous scan, shown as a small arrow
  title?: string            // hover text
  href?: string             // opened in a new tab on click when set
  onClick?: () => void
}

interface Props { pins: MapPin[]; height?: number; className?: string; fitKey?: string }

const FILL: Record<RankBand, string> = { top3: '#16a34a', top10: '#d97706', top20: '#dc2626', none: '#6b7280' }

function pinSvg(fill: string, label: string, delta?: number | null, size = 40): string {
  const arrow = delta && delta !== 0 ? `<text x="20" y="${size * 0.92}" font-size="9" text-anchor="middle" fill="${delta > 0 ? '#16a34a' : '#dc2626'}" font-family="system-ui" font-weight="700">${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size + 10}" viewBox="0 0 40 50">
    <path d="M20 48 C20 48 4 28 4 17 A16 16 0 0 1 36 17 C36 28 20 48 20 48 Z" fill="${fill}" stroke="#ffffff" stroke-width="2"/>
    <text x="20" y="22" font-size="${label.length > 2 ? 11 : 15}" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-weight="700">${label}</text>
    ${arrow}
  </svg>`
}

export default function RankMap({ pins, height = 420, className = '', fitKey }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<LeafletMap | null>(null)
  const layer = useRef<LayerGroup | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const L = (await import('leaflet')).default
      if (cancelled || !el.current) return
      if (!map.current) {
        map.current = L.map(el.current, { scrollWheelZoom: false, attributionControl: true })
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map.current)
        layer.current = L.layerGroup().addTo(map.current)
      }
      const m = map.current, g = layer.current!
      g.clearLayers()
      const bounds: Array<[number, number]> = []
      for (const p of pins) {
        bounds.push([p.lat, p.lng])
        let icon
        if (p.kind === 'us') icon = L.divIcon({ className: '', html: pinSvg('#dc2626', '★', null, 34), iconSize: [34, 44], iconAnchor: [17, 42] })
        else if (p.kind === 'center') icon = L.divIcon({ className: '', html: '<div style="width:12px;height:12px;border-radius:50%;background:#111827;border:2px solid #fff;box-shadow:0 0 0 1px #111827"></div>', iconSize: [12, 12], iconAnchor: [6, 6] })
        else icon = L.divIcon({ className: '', html: pinSvg(FILL[p.band ?? 'none'], p.label ?? '—', p.delta), iconSize: [40, 50], iconAnchor: [20, 48] })
        const marker = L.marker([p.lat, p.lng], { icon, title: p.title, zIndexOffset: p.kind === 'us' ? 1000 : p.kind === 'center' ? -100 : 0 })
        if (p.title) marker.bindTooltip(p.title, { direction: 'top', offset: [0, -40] })
        if (p.onClick || p.href) marker.on('click', () => { if (p.onClick) p.onClick(); else if (p.href) window.open(p.href, '_blank', 'noopener') })
        marker.addTo(g)
      }
      if (bounds.length === 1) m.setView(bounds[0], 13)
      else if (bounds.length > 1) m.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 })
      // The container may have been laid out after the map was created (modal open).
      setTimeout(() => m.invalidateSize(), 0)
    })()
    return () => { cancelled = true }
    // fitKey lets the caller force a refit (e.g. a new scan in the same modal).
  }, [pins, fitKey])

  useEffect(() => () => { map.current?.remove(); map.current = null; layer.current = null }, [])

  return <div ref={el} className={`w-full rounded-lg overflow-hidden border border-gray-200 ${className}`} style={{ height }} />
}
