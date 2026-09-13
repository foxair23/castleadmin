import crypto from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sfMirrorGet } from '@/lib/sf-mirror/client'
import { getToken } from '@/lib/crm/service-fusion'
import { llm, isLlmConfigured, isAdaptiveThinkingModel, describeLlmError } from '@/lib/agent/llm'

// Job photos for profile posts (PRD §6.1–6.3). Three steps, each idempotent:
//   1. fetch  — Service Fusion exposes a job's pictures through `expand=pictures`
//               (typ.Picture: name, file_location, doc_type, comment, sort, is_private).
//   2. import — copy each picture into the public gbp-media bucket, resized and
//               with EXIF/GPS stripped, because Google fetches post photos by URL.
//   3. score  — Claude looks at every photo of the job at once, scores relevance
//               0–100 with reasons, tags before/after/finished, and pairs them.
// Nothing is posted with a photo below the threshold; the scores also feed the
// photo-quality-by-tech report.

export const MEDIA_BUCKET = 'gbp-media'
const MAX_SOURCE_BYTES = 15 * 1024 * 1024
const MAX_EDGE = 1200

export interface SfPicture {
  fileLocation: string
  name: string | null
  docType: string | null
  comment: string | null
  isPrivate: boolean
  createdAt: string | null
  sort: number | null
}

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)(\?|$)/i
const IMAGE_TYPE = /image|photo|picture|jpe?g|png/i

/** Pure: the usable pictures out of an SF job payload (direct object or list-wrapped). */
export function parseSfPictures(raw: unknown): SfPicture[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j: any = raw
  const job = j?.items ? (j.items[0] ?? null) : (j?.id ? j : (j?.data ?? null))
  const list: unknown[] = Array.isArray(job?.pictures) ? job.pictures : Array.isArray(job?.pictures?.items) ? job.pictures.items : []
  const seen = new Set<string>()
  const out: SfPicture[] = []
  for (const p of list as Array<Record<string, unknown>>) {
    const loc = typeof p?.file_location === 'string' ? p.file_location.trim() : typeof p?.url === 'string' ? (p.url as string).trim() : ''
    if (!loc || seen.has(loc)) continue
    const name = typeof p.name === 'string' ? p.name : null
    const docType = typeof p.doc_type === 'string' ? p.doc_type : null
    const looksImage = IMAGE_EXT.test(loc) || IMAGE_EXT.test(name ?? '') || IMAGE_TYPE.test(docType ?? '') || (!/\.(pdf|docx?|xlsx?|txt|csv)(\?|$)/i.test(loc) && !docType)
    if (!looksImage) continue
    if (p.is_private === true) continue
    seen.add(loc)
    out.push({
      fileLocation: loc, name, docType,
      comment: typeof p.comment === 'string' ? p.comment : null,
      isPrivate: false,
      createdAt: typeof p.created_at === 'string' ? p.created_at : null,
      sort: typeof p.sort === 'number' ? p.sort : null,
    })
  }
  return out.sort((a, b) => (a.sort ?? 1e9) - (b.sort ?? 1e9) || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
}

/** Live read of one job's pictures from Service Fusion. Returns the raw payload too, for the diagnostic. */
export async function fetchJobPictures(sfJobId: string): Promise<{ pictures: SfPicture[]; raw: unknown }> {
  const raw = await sfMirrorGet(`/jobs/${encodeURIComponent(sfJobId)}`, { expand: 'pictures' })
  return { pictures: parseSfPictures(raw), raw }
}

async function downloadPicture(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  const attempt = async (headers: Record<string, string>) => {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 20_000)
    try { return await fetch(url, { headers, signal: controller.signal, redirect: 'follow' }) } finally { clearTimeout(t) }
  }
  let res = await attempt({})
  if (res.status === 401 || res.status === 403) res = await attempt({ Authorization: `Bearer ${await getToken()}` })
  if (!res.ok) throw new Error(`picture download failed ${res.status}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_SOURCE_BYTES) throw new Error('picture larger than 15 MB')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > MAX_SOURCE_BYTES) throw new Error('picture larger than 15 MB')
  return { bytes: buf, contentType: res.headers.get('content-type') }
}

/** Resize to fit 1200px, auto-rotate, re-encode as JPEG. No metadata is carried over (EXIF/GPS gone). */
export async function normalizeImage(bytes: Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const sharp = (await import('sharp')).default
  const out = await sharp(bytes, { failOn: 'none' }).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true })
  return { jpeg: out.data, width: out.info.width, height: out.info.height }
}

export interface JobPhotoRow {
  id: string; sf_job_id: string; source: string; source_ref: string; source_name: string | null
  storage_path: string | null; public_url: string | null; width: number | null; height: number | null; bytes: number | null
  score: number | null; score_reasons: string[]; shows: 'before' | 'after' | 'finished' | 'other' | null; subject: string | null
  pair_id: string | null; override_usable: boolean | null; scored_at: string | null; score_model: string | null; error: string | null
  created_at: string; updated_at: string
}

export const PHOTO_SELECT = 'id, sf_job_id, source, source_ref, source_name, storage_path, public_url, width, height, bytes, score, score_reasons, shows, subject, pair_id, override_usable, scored_at, score_model, error, created_at, updated_at'

export interface ImportReport { found: number; imported: number; skipped: number; errors: string[] }

/** Copy every new picture of a job into gbp-media and record it. Re-runnable. */
export async function importJobPhotos(db: SupabaseClient, sfJobId: string): Promise<ImportReport> {
  const report: ImportReport = { found: 0, imported: 0, skipped: 0, errors: [] }
  const { pictures } = await fetchJobPictures(sfJobId)
  report.found = pictures.length
  if (!pictures.length) return report
  const { data: have } = await db.from('job_photos').select('source_ref').eq('sf_job_id', sfJobId)
  const seen = new Set(((have ?? []) as Array<{ source_ref: string }>).map(h => h.source_ref))
  for (const p of pictures) {
    if (seen.has(p.fileLocation)) { report.skipped++; continue }
    const nowIso = new Date().toISOString()
    try {
      const { bytes } = await downloadPicture(p.fileLocation)
      const img = await normalizeImage(bytes)
      const key = crypto.createHash('sha1').update(p.fileLocation).digest('hex').slice(0, 16)
      const path = `jobs/${encodeURIComponent(sfJobId)}/${key}.jpg`
      const { error: upErr } = await db.storage.from(MEDIA_BUCKET).upload(path, img.jpeg, { contentType: 'image/jpeg', upsert: true })
      if (upErr) throw new Error(`upload: ${upErr.message}`)
      const publicUrl = db.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl
      const { error } = await db.from('job_photos').insert({
        sf_job_id: sfJobId, source: 'sf', source_ref: p.fileLocation, source_name: p.name,
        storage_path: path, public_url: publicUrl, width: img.width, height: img.height, bytes: img.jpeg.byteLength,
        created_at: nowIso, updated_at: nowIso,
      })
      if (error && error.code !== '23505') throw new Error(error.message)
      report.imported++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      report.errors.push(`${p.name ?? p.fileLocation}: ${msg}`)
      // Keep a row so the failure is visible and the picture is not retried every run.
      await db.from('job_photos').upsert({ sf_job_id: sfJobId, source: 'sf', source_ref: p.fileLocation, source_name: p.name, error: msg.slice(0, 300), created_at: nowIso, updated_at: nowIso }, { onConflict: 'sf_job_id,source_ref', ignoreDuplicates: true })
    }
  }
  return report
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const SCORE_TOOL: Anthropic.Tool = {
  name: 'score_job_photos',
  description: 'Score each photo of one finished garage door / gate job for use on the company\'s public Google profile, and pair before/after shots.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['photos', 'pairs'],
    properties: {
      photos: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['index', 'score', 'reasons', 'shows', 'subject'],
          properties: {
            index: { type: 'integer', description: 'The 1-based photo number as given.' },
            score: { type: 'integer', description: '0–100 relevance for a public post. 90+: clean finished product, well framed. 70–89: usable. Below 70: do not post.' },
            reasons: { type: 'array', items: { type: 'string' }, description: 'Short reasons, especially for anything that lowers the score (clutter, people, house number, plate, blur, unfinished work, interior junk).' },
            shows: { type: 'string', enum: ['before', 'after', 'finished', 'other'], description: '"before" = the old/broken state, "after" = the same spot finished, "finished" = finished work with no before shot, "other" = not the product.' },
            subject: { type: ['string', 'null'], description: 'What the photo shows in a few words, e.g. "double garage door, white, raised panel". Null if unclear.' },
          },
        },
      },
      pairs: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['before_index', 'after_index'], properties: { before_index: { type: 'integer' }, after_index: { type: 'integer' } } },
        description: 'Before/after pairs of the SAME door or gate. Empty if none.',
      },
    },
  },
}

const RUBRIC = `You are screening job photos for Castle Garage Doors & Gates' public Google Business Profile.
Score each photo 0–100 for use in a post about the finished job:
- The door, gate, or opener is the clear subject; the work is finished and clean; framing is straight and well lit → high.
- A "before" shot of the old or broken door/gate is valuable ONLY when there is also an "after" of the same spot; score it by how clearly it shows the problem.
- Subtract heavily for: people or faces, house numbers or street signs, license plates, a cluttered garage interior full of belongings, tools or debris on the floor, blur, darkness, partial framing, screenshots, paperwork.
- Anything that identifies the customer or the home is disqualifying (score under 40) even if the door looks great.
Be strict: the company is training its technicians to take better photos, and honest low scores with clear reasons are the point.`

export interface PhotoScore { index: number; score: number; reasons: string[]; shows: 'before' | 'after' | 'finished' | 'other'; subject: string | null }

/** Pure: clean the model's output against the photo count. */
export function normalizePhotoScores(raw: unknown, count: number): { photos: PhotoScore[]; pairs: Array<[number, number]> } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { photos?: unknown; pairs?: unknown }
  const photos: PhotoScore[] = []
  const seen = new Set<number>()
  for (const p of Array.isArray(r.photos) ? r.photos : []) {
    const o = p as Record<string, unknown>
    const idx = Number(o.index)
    if (!Number.isInteger(idx) || idx < 1 || idx > count || seen.has(idx)) continue
    seen.add(idx)
    const shows = ['before', 'after', 'finished', 'other'].includes(o.shows as string) ? (o.shows as PhotoScore['shows']) : 'other'
    photos.push({
      index: idx,
      score: Math.max(0, Math.min(100, Math.round(Number(o.score) || 0))),
      reasons: (Array.isArray(o.reasons) ? o.reasons : []).filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean).slice(0, 6),
      shows,
      subject: typeof o.subject === 'string' && o.subject.trim() ? o.subject.trim().slice(0, 80) : null,
    })
  }
  const pairs: Array<[number, number]> = []
  const used = new Set<number>()
  for (const q of Array.isArray(r.pairs) ? r.pairs : []) {
    const o = q as Record<string, unknown>
    const b = Number(o.before_index), a = Number(o.after_index)
    if (!Number.isInteger(b) || !Number.isInteger(a) || b === a || b < 1 || a < 1 || b > count || a > count || used.has(b) || used.has(a)) continue
    used.add(b); used.add(a); pairs.push([b, a])
  }
  return { photos, pairs }
}

export interface ScoreReport { scored: number; pairs: number; skipped?: string; error?: string }

/** Score every unscored photo of a job in one vision call and record pairs. */
export async function scoreJobPhotos(db: SupabaseClient, sfJobId: string, model: string, ctx?: { category?: string | null; description?: string | null }): Promise<ScoreReport> {
  if (!isLlmConfigured()) return { scored: 0, pairs: 0, skipped: 'llm_not_configured' }
  const { data } = await db.from('job_photos').select(PHOTO_SELECT).eq('sf_job_id', sfJobId).is('score', null).not('storage_path', 'is', null).order('created_at', { ascending: true }).limit(8)
  const rows = (data ?? []) as JobPhotoRow[]
  if (!rows.length) return { scored: 0, pairs: 0 }
  const content: Anthropic.ContentBlockParam[] = []
  const loaded: JobPhotoRow[] = []
  for (const r of rows) {
    const { data: file } = await db.storage.from(MEDIA_BUCKET).download(r.storage_path!)
    if (!file) continue
    const b64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    loaded.push(r)
    content.push({ type: 'text', text: `Photo ${loaded.length}${r.source_name ? ` (${r.source_name})` : ''}:` })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })
  }
  if (!loaded.length) return { scored: 0, pairs: 0 }
  content.push({ type: 'text', text: `Job type: ${ctx?.category ?? 'unknown'}${ctx?.description ? `\nJob description: ${ctx.description.slice(0, 300)}` : ''}\n\nScore all ${loaded.length} photos with score_job_photos.` })
  try {
    const res = await llm().messages.create({
      model, max_tokens: 1500, system: RUBRIC,
      tools: [SCORE_TOOL], tool_choice: { type: 'tool', name: 'score_job_photos' },
      ...(isAdaptiveThinkingModel(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } } : {}),
      messages: [{ role: 'user', content }],
    })
    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    const { photos, pairs } = normalizePhotoScores(tu?.input, loaded.length)
    const nowIso = new Date().toISOString()
    const pairIdByIndex = new Map<number, string>()
    for (const [b, a] of pairs) { const id = crypto.randomUUID(); pairIdByIndex.set(b, id); pairIdByIndex.set(a, id) }
    let scored = 0
    for (const p of photos) {
      const row = loaded[p.index - 1]
      const shows = pairIdByIndex.has(p.index) ? (pairs.find(([b]) => b === p.index) ? 'before' : 'after') : p.shows
      await db.from('job_photos').update({ score: p.score, score_reasons: p.reasons, shows, subject: p.subject, pair_id: pairIdByIndex.get(p.index) ?? null, scored_at: nowIso, score_model: res.model, error: null, updated_at: nowIso }).eq('id', row.id)
      scored++
    }
    // Anything the model did not return gets a conservative score so it is not retried forever.
    for (let i = 0; i < loaded.length; i++) {
      if (!photos.some(p => p.index === i + 1)) await db.from('job_photos').update({ score: 0, score_reasons: ['not scored by the model'], shows: 'other', scored_at: nowIso, score_model: res.model, updated_at: nowIso }).eq('id', loaded[i].id)
    }
    return { scored, pairs: pairs.length }
  } catch (e) {
    return { scored: 0, pairs: 0, error: describeLlmError(e) }
  }
}

// ── Selection ───────────────────────────────────────────────────────────────

export const isUsable = (p: JobPhotoRow, threshold: number): boolean =>
  !!p.public_url && (p.override_usable ?? ((p.score ?? -1) >= threshold))

/** Pure: the photo(s) a post should carry — the best before/after pair when both are usable, else the single best. */
export function pickPostPhotos(photos: JobPhotoRow[], threshold: number): JobPhotoRow[] {
  const usable = photos.filter(p => isUsable(p, threshold))
  const byPair = new Map<string, JobPhotoRow[]>()
  for (const p of usable) if (p.pair_id) byPair.set(p.pair_id, [...(byPair.get(p.pair_id) ?? []), p])
  let bestPair: JobPhotoRow[] | null = null
  for (const group of byPair.values()) {
    const before = group.find(p => p.shows === 'before'), after = group.find(p => p.shows === 'after')
    if (!before || !after) continue
    const total = (before.score ?? 0) + (after.score ?? 0)
    if (!bestPair || total > (bestPair[0].score ?? 0) + (bestPair[1].score ?? 0)) bestPair = [before, after]
  }
  if (bestPair) return bestPair
  const singles = usable.filter(p => p.shows !== 'before').sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return singles.slice(0, 1)
}
