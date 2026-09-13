// Import owner replies from a CSV export of another business's Google reviews
// (for example the Apify "Google Maps Reviews Scraper" export) as style
// examples. Pure functions, no server imports, so the browser can parse the
// file and send only the three fields that matter.

export interface ImportedExample { stars: number | null; review: string | null; reply: string; business: string | null }

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false
  const src = text.startsWith('﻿') ? text.slice(1) : text
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f !== '')) rows.push(row)
  return rows
}

const REPLY_COLS = ['responsefromownertext', 'owner_response', 'ownerresponse', 'response', 'reply', 'reply_text', 'owner_reply']
const REVIEW_COLS = ['text', 'review', 'review_text', 'comment', 'body']
const STARS_COLS = ['stars', 'rating', 'star_rating', 'score']
const BUSINESS_COLS = ['title', 'business', 'business_name', 'name_of_business']

function findCol(headers: string[], candidates: string[]): number {
  const norm = headers.map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
  for (const c of candidates) { const i = norm.indexOf(c.replace(/[^a-z0-9]/g, '')); if (i >= 0) return i }
  return -1
}

/** Rows that carry an owner reply. Returns an error message when no reply column can be found. */
export function extractReviewExamples(csvText: string): { rows: ImportedExample[]; error?: string; columns: { reply: string | null; review: string | null; stars: string | null } } {
  const table = parseCsv(csvText)
  if (table.length < 2) return { rows: [], error: 'The file has no data rows.', columns: { reply: null, review: null, stars: null } }
  const headers = table[0]
  const ri = findCol(headers, REPLY_COLS), ti = findCol(headers, REVIEW_COLS), si = findCol(headers, STARS_COLS), bi = findCol(headers, BUSINESS_COLS)
  const columns = { reply: ri >= 0 ? headers[ri] : null, review: ti >= 0 ? headers[ti] : null, stars: si >= 0 ? headers[si] : null }
  if (ri < 0) return { rows: [], error: `No owner-reply column found. Expected one of: ${REPLY_COLS.slice(0, 4).join(', ')}.`, columns }
  const rows: ImportedExample[] = []
  for (const r of table.slice(1)) {
    const reply = (r[ri] ?? '').trim()
    if (!reply) continue
    const starsRaw = si >= 0 ? Number(String(r[si] ?? '').trim()) : NaN
    rows.push({
      reply,
      review: ti >= 0 ? (r[ti] ?? '').trim() || null : null,
      stars: Number.isFinite(starsRaw) && starsRaw >= 1 && starsRaw <= 5 ? Math.round(starsRaw) : null,
      business: bi >= 0 ? (r[bi] ?? '').trim() || null : null,
    })
  }
  return { rows, columns }
}

export interface ImportFilter { minReplyWords: number; requireStars: boolean }
export const DEFAULT_IMPORT_FILTER: ImportFilter = { minReplyWords: 12, requireStars: true }

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Drop throwaway replies and duplicates. Returns what survives plus why the rest was skipped. */
export function filterExamples(rows: ImportedExample[], filter: ImportFilter): { keep: ImportedExample[]; skipped: { short: number; noStars: number; duplicate: number } } {
  const seen = new Set<string>()
  const skipped = { short: 0, noStars: 0, duplicate: 0 }
  const keep: ImportedExample[] = []
  for (const r of rows) {
    if (wordCount(r.reply) < filter.minReplyWords) { skipped.short++; continue }
    if (filter.requireStars && r.stars == null) { skipped.noStars++; continue }
    const key = norm(r.reply)
    if (seen.has(key)) { skipped.duplicate++; continue }
    seen.add(key); keep.push(r)
  }
  return { keep, skipped }
}

export const bandForStars = (stars: number | null): 'positive' | 'negative' => (stars ?? 5) >= 4 ? 'positive' : 'negative'
