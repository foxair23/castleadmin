// Pure helpers for Map Pack rank tracking (PRD §8): grid geometry, the shape of
// one result, identifying Castle's own listing, and per-scan statistics.

export interface LatLng { lat: number; lng: number }
export interface GridPoint extends LatLng { row: number; col: number }

const MILES_PER_DEG_LAT = 69.0

/** An n×n lattice centered on `center`, `spacingMiles` apart. Size 1 is the center alone. Row 0 is north. */
export function gridPoints(center: LatLng, size: number, spacingMiles: number): GridPoint[] {
  const n = Math.max(1, Math.round(size))
  const half = (n - 1) / 2
  const dLat = spacingMiles / MILES_PER_DEG_LAT
  const dLng = spacingMiles / (MILES_PER_DEG_LAT * Math.cos(center.lat * Math.PI / 180))
  const out: GridPoint[] = []
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      out.push({ row, col, lat: round6(center.lat + (half - row) * dLat), lng: round6(center.lng + (col - half) * dLng) })
    }
  }
  return out
}
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** One business in a Maps result list, trimmed to what the reports need. */
export interface RankResult {
  rank: number; title: string; rating: number | null; reviews: number | null
  place_id: string | null; cid: string | null; address: string | null; category: string | null; is_us: boolean
  lat?: number | null; lng?: number | null
}

/** Case-insensitive, punctuation-insensitive test for Castle's own listing. */
export function isOurListing(title: string | null | undefined, match: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const m = norm(match)
  return !!m && norm(title ?? '').includes(m)
}

/** Parse a DataForSEO Google Maps `items` array (or anything shaped like it) into ranked results. Unknown shapes yield []. */
export function parseMapsItems(raw: unknown, match: string, depth = 20): RankResult[] {
  if (!Array.isArray(raw)) return []
  const out: RankResult[] = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if (o.type && o.type !== 'maps_search') continue
    const title = typeof o.title === 'string' ? o.title : ''
    if (!title) continue
    const rank = num(o.rank_group) ?? num(o.rank_absolute) ?? out.length + 1
    if (rank > depth) continue
    const rating = (o.rating && typeof o.rating === 'object' ? o.rating : {}) as Record<string, unknown>
    out.push({
      rank, title, rating: num(rating.value), reviews: num(rating.votes_count),
      place_id: str(o.place_id), cid: str(o.cid), address: str(o.address), category: str(o.category), is_us: isOurListing(title, match),
      lat: num(o.latitude), lng: num(o.longitude),
    })
  }
  return out.sort((a, b) => a.rank - b.rank)
}
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null
const str = (v: unknown): string | null => typeof v === 'string' && v ? v : v != null && typeof v === 'number' ? String(v) : null

/** Our rank at a point: the best-ranked result that is us, else null. */
export function ourRank(results: RankResult[]): number | null {
  const us = results.filter(r => r.is_us).map(r => r.rank)
  return us.length ? Math.min(...us) : null
}

export interface ScanStats { points: number; found: number; avgRank: number | null; foundShare: number; top3Share: number; top10Share: number }

/** Per-scan numbers from the points' our_rank values. Points with an error are excluded. */
export function scanStats(points: Array<{ our_rank: number | null; error?: string | null }>): ScanStats {
  const ok = points.filter(p => !p.error)
  const ranks = ok.map(p => p.our_rank).filter((r): r is number => r != null)
  const n = ok.length
  return {
    points: n, found: ranks.length,
    avgRank: ranks.length ? Math.round(ranks.reduce((s, r) => s + r, 0) / ranks.length * 100) / 100 : null,
    foundShare: n ? Math.round(ranks.length / n * 1000) / 1000 : 0,
    top3Share: n ? Math.round(ranks.filter(r => r <= 3).length / n * 1000) / 1000 : 0,
    top10Share: n ? Math.round(ranks.filter(r => r <= 10).length / n * 1000) / 1000 : 0,
  }
}

export type RankBand = 'top3' | 'top10' | 'top20' | 'none'
export const bandFor = (rank: number | null): RankBand => rank == null ? 'none' : rank <= 3 ? 'top3' : rank <= 10 ? 'top10' : 'top20'

/** Rough provider cost per request, for the estimate shown before a scan runs. */
export const COST_PER_REQUEST_USD = 0.002
