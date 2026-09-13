// Turn a typed place ("Vista, CA", "92084", "123 Main St Escondido") into a
// coordinate for the Check-now form and for adding places. Uses OpenStreetMap's
// Nominatim, which is free and needs no key but asks for a descriptive
// User-Agent and light use (a handful of lookups a day here).

export interface GeocodeHit { lat: number; lng: number; label: string; kind: 'city' | 'zip' | 'pin' }

export async function geocode(query: string): Promise<GeocodeHit | null> {
  const q = query.trim()
  if (!q) return null
  const m = q.match(/^-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+$/)
  if (m) { const [lat, lng] = q.split(',').map(s => Number(s.trim())); return { lat, lng, label: q, kind: 'pin' } }
  const isZip = /^\d{5}$/.test(q)
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('format', 'jsonv2'); url.searchParams.set('limit', '1'); url.searchParams.set('countrycodes', 'us')
  if (isZip) url.searchParams.set('postalcode', q); else url.searchParams.set('q', /\b(ca|california)\b/i.test(q) ? q : `${q}, California`)
  const res = await fetch(url, { headers: { 'User-Agent': 'CastleAdmin/1.0 (rank tracking; office use)' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`)
  const rows = (await res.json()) as Array<{ lat: string; lon: string; display_name: string; addresstype?: string }>
  const hit = rows[0]
  if (!hit) return null
  const kind: GeocodeHit['kind'] = isZip ? 'zip' : hit.addresstype === 'city' || hit.addresstype === 'town' || hit.addresstype === 'village' || hit.addresstype === 'suburb' ? 'city' : 'pin'
  return { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name.split(',').slice(0, 2).join(',').trim(), kind }
}
