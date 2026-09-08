import { sfMirrorGet } from '@/lib/sf-mirror/client'

// Live refresh — the ONLY way an agent channel reads Service Fusion directly.
//
// Rule (PRD §6.4): never answer from the mirror alone. Once the resolver has picked a
// job, this reads that ONE job live before any fact is used, and again immediately
// before a reply is sent. It goes through the GET-only mirror client, so it cannot
// write — see __tests__/agent-read-only.test.ts and sf-mirror-client.test.ts.
//
// Failure policy: a failed or too-old read is reported as such. There is NO silent
// fallback to cached or mirror data — the caller must route the reply to human
// review. Silently answering from stale data is the exact failure this exists to stop.
//
// Cache: a short in-memory cache (per serverless instance) keyed by job id, so several
// inquiries about the same job in quick succession cost one SF call. An entry is only
// served while younger than the caller's staleness tolerance; in-flight reads are
// shared so concurrent asks don't stampede SF.

export interface LiveTech { id: string; name: string }

/** The facts a reply may state about a job — nothing more. Field names are stable
 *  because the composer's grounding annotations and the send-time re-verify both
 *  refer to them. */
export interface LiveJobFacts {
  jobId: string
  jobNumber: string | null
  status: string | null
  subStatus: string | null
  customerName: string | null
  poNumber: string | null
  /** Scheduled start/end (ISO or SF's 'YYYY-MM-DD HH:mm:ss'). */
  startDate: string | null
  endDate: string | null
  /** Promised arrival window on the visit, if SF has one. */
  windowStart: string | null
  windowEnd: string | null
  /** When the work was completed/closed in SF (completed_date, else closed_at). */
  completedAt: string | null
  techs: LiveTech[]
  city: string | null
  postalCode: string | null
  requiresFollowUp: boolean
  /** SF's own last-modified stamp for the job. */
  updatedAtSf: string | null
  /** When WE read it. Freshness is judged from this. */
  fetchedAt: string
}

export type LiveRefreshResult =
  | { status: 'fresh'; facts: LiveJobFacts; fromCache: boolean; ageMs: number }
  | { status: 'failed'; error: string; jobId: string }

export const DEFAULT_STALENESS_MS = 5 * 60_000

// ── Mapping ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>

const str = (v: unknown): string | null => {
  if (v == null || v === '' || v === 0 || v === '0') return null
  return String(v)
}

/** SF returns a single resource directly; be tolerant of list/data wrappers. */
export function unwrapJob(json: unknown): Raw | null {
  const j = json as Raw | null
  if (!j) return null
  if (Array.isArray(j.items)) return j.items[0] ?? null
  if (j.id != null) return j
  if (j.data && typeof j.data === 'object') return j.data as Raw
  return null
}

const techName = (t: Raw): string =>
  `${t.first_name ?? ''} ${t.last_name ?? ''}`.trim() || str(t.name) || `Tech ${t.id}`

export function mapLiveJob(raw: Raw, fetchedAt = new Date().toISOString()): LiveJobFacts {
  // Techs: job-level assignment, plus any visit-level techs not already listed.
  const techs = new Map<string, LiveTech>()
  for (const t of Array.isArray(raw.techs_assigned) ? raw.techs_assigned : []) {
    techs.set(String(t.id), { id: String(t.id), name: techName(t) })
  }
  const visits: Raw[] = Array.isArray(raw.visits) ? raw.visits : []
  for (const v of visits) for (const t of Array.isArray(v.techs_assigned) ? v.techs_assigned : []) {
    if (!techs.has(String(t.id))) techs.set(String(t.id), { id: String(t.id), name: techName(t) })
  }
  return {
    jobId: String(raw.id),
    jobNumber: str(raw.number),
    status: str(raw.status),
    subStatus: str(raw.sub_status),
    customerName: str(raw.customer_name),
    poNumber: str(raw.po_number),
    startDate: str(raw.start_date),
    endDate: str(raw.end_date),
    windowStart: str(raw.time_frame_promised_start),
    windowEnd: str(raw.time_frame_promised_end),
    completedAt: str(raw.completed_date) ?? str(raw.closed_at),
    techs: [...techs.values()],
    city: str(raw.city),
    postalCode: str(raw.postal_code),
    requiresFollowUp: raw.is_requires_follow_up === true || raw.is_requires_follow_up === 1 || raw.is_requires_follow_up === '1',
    updatedAtSf: str(raw.updated_at),
    fetchedAt,
  }
}

// ── Refresh with cache ────────────────────────────────────────────────────────

export type LiveGet = (path: string, params?: Record<string, string>) => Promise<unknown>

interface CacheEntry { facts: LiveJobFacts; at: number }
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<LiveJobFacts>>()

const EXPAND = 'techs_assigned,visits,visits.techs_assigned'

export interface RefreshOptions {
  /** Serve a cached read if younger than this. Default 5 minutes (PRD staleness tolerance). */
  stalenessMs?: number
  /** Skip the cache — used for the send-time re-verify. */
  force?: boolean
  /** Injected reader for tests. Defaults to the GET-only mirror client. */
  get?: LiveGet
  now?: () => number
}

async function readLive(jobId: string, get: LiveGet, now: () => number): Promise<LiveJobFacts> {
  const running = inflight.get(jobId)
  if (running) return running
  const p = (async () => {
    const json = await get(`/jobs/${encodeURIComponent(jobId)}`, { expand: EXPAND })
    const raw = unwrapJob(json)
    if (!raw || raw.id == null) throw new Error(`Job ${jobId} not found in Service Fusion`)
    const facts = mapLiveJob(raw, new Date(now()).toISOString())
    cache.set(jobId, { facts, at: now() })
    return facts
  })()
  inflight.set(jobId, p)
  try { return await p } finally { inflight.delete(jobId) }
}

/** Read one job live. Never returns stale data as fresh; never throws. */
export async function refreshJob(jobId: string, opts: RefreshOptions = {}): Promise<LiveRefreshResult> {
  const now = opts.now ?? Date.now
  const stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS
  const get = opts.get ?? sfMirrorGet

  if (!opts.force) {
    const hit = cache.get(jobId)
    if (hit && now() - hit.at < stalenessMs) return { status: 'fresh', facts: hit.facts, fromCache: true, ageMs: now() - hit.at }
  }
  try {
    const facts = await readLive(jobId, get, now)
    return { status: 'fresh', facts, fromCache: false, ageMs: 0 }
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e), jobId }
  }
}

/** True when the facts are younger than the tolerance (checked again at send time). */
export function isFresh(facts: LiveJobFacts, stalenessMs = DEFAULT_STALENESS_MS, now = Date.now()): boolean {
  const t = Date.parse(facts.fetchedAt)
  return !Number.isNaN(t) && now - t <= stalenessMs
}

/** Test/ops hook. */
export function clearLiveCache(): void { cache.clear(); inflight.clear() }

// ── Send-time re-verify ───────────────────────────────────────────────────────

/** Fields a partner-facing reply can depend on. Anything else changing is irrelevant. */
export const STATED_FACT_FIELDS = [
  'status', 'subStatus', 'startDate', 'endDate', 'windowStart', 'windowEnd', 'completedAt', 'techs', 'poNumber', 'customerName',
] as const satisfies readonly (keyof LiveJobFacts)[]

export type StatedFactField = (typeof STATED_FACT_FIELDS)[number]

/** Which stated facts differ between the read the reply was composed from and a
 *  fresh read. Empty → safe to send. Non-empty → cancel and recompose (or review). */
export function changedFacts(before: LiveJobFacts, after: LiveJobFacts): StatedFactField[] {
  const out: StatedFactField[] = []
  for (const f of STATED_FACT_FIELDS) {
    if (f === 'techs') {
      const a = before.techs.map(t => t.id).sort().join(','), b = after.techs.map(t => t.id).sort().join(',')
      if (a !== b) out.push(f)
    } else if ((before[f] ?? null) !== (after[f] ?? null)) out.push(f)
  }
  return out
}

/** A change that means the reply's premise moved, not just its wording — route to review
 *  rather than auto-recompose (PRD §6.4: cancelled, rescheduled, reassigned). */
export function isMaterialChange(fields: StatedFactField[]): boolean {
  return fields.some(f => f === 'status' || f === 'startDate' || f === 'endDate' || f === 'techs' || f === 'completedAt')
}
