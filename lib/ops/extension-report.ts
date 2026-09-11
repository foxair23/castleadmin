import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// What the office extension tells the app, and what the app tells it back. Every run,
// crawl, login and warm-up lands in extension_runs; a heartbeat every 10 minutes keeps
// extension_heartbeat fresh; the response to any report carries the commands the owner
// queued from the Health page, so remote control costs no extra polling.

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export const REPORT_KINDS = ['heartbeat', 'run', 'crawl', 'login', 'warm', 'command'] as const
export type ReportKind = typeof REPORT_KINDS[number]
export const COMMAND_KINDS = ['run_now', 'crawl', 'relogin', 'warm', 'clear_badge', 'set_config'] as const
export type CommandKind = typeof COMMAND_KINDS[number]
/** Config keys a remote command may change. Never credentials. */
export const SETTABLE_KEYS = ['enabled', 'dryRun', 'genieScheduleEnabled', 'clopayScheduleEnabled', 'clopayDocSyncEnabled', 'pollMinutes'] as const
const SITES = ['genie', 'clopay', 'service_fusion', 'castle_admin']
const MODES = ['full', 'incremental', 'docs', 'warm']
const MAX_LOG_ENTRIES = 100
const MAX_LOG_ENTRY_CHARS = 400
const MAX_LOG_BYTES = 16_000

export interface ExtensionReport {
  device: string; version: string | null; chrome: string | null; at: string | null
  kind: ReportKind; source: string | null; site: string | null; mode: string | null
  status: string; reason: string | null; started_at: string | null; finished_at: string | null
  counts: Record<string, unknown> | null; log: unknown[] | null; state: Record<string, unknown> | null
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const iso = (v: unknown): string | null => { if (typeof v === 'number') return new Date(v).toISOString(); if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString(); return null }

/** Validate and trim a raw report body. Returns null when it is not a report at all. */
export function normalizeReport(body: unknown): ExtensionReport | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const kind = str(b.kind, 20) as ReportKind | null
  if (!kind || !REPORT_KINDS.includes(kind)) return null
  const site = str(b.site, 30)
  const mode = str(b.mode, 20)
  const state = b.state && typeof b.state === 'object' ? { ...(b.state as Record<string, unknown>) } : null
  if (state) { for (const k of Object.keys(state)) if (/pass|token|secret|password/i.test(k)) delete state[k] }
  return {
    device: str(b.device, 60) ?? 'office',
    version: str(b.version, 20), chrome: str(b.chrome, 40), at: iso(b.at) ?? new Date().toISOString(),
    kind, source: str(b.source, 60), site: site && SITES.includes(site) ? site : site, mode: mode && MODES.includes(mode) ? mode : mode,
    status: str(b.status, 20) ?? (kind === 'heartbeat' ? 'ok' : 'done'), reason: str(b.reason, 200),
    started_at: iso(b.started_at), finished_at: iso(b.finished_at),
    counts: b.counts && typeof b.counts === 'object' ? (b.counts as Record<string, unknown>) : null,
    log: trimLog(b.log), state,
  }
}

export function trimLog(log: unknown): unknown[] | null {
  if (!Array.isArray(log) || !log.length) return null
  const out: unknown[] = []
  let bytes = 0
  for (const e of log.slice(0, MAX_LOG_ENTRIES)) {
    const s = typeof e === 'string' ? e : JSON.stringify(e)
    const clipped = s.length > MAX_LOG_ENTRY_CHARS ? s.slice(0, MAX_LOG_ENTRY_CHARS) + '…' : s
    bytes += clipped.length
    if (bytes > MAX_LOG_BYTES) break
    out.push(typeof e === 'string' || clipped !== s ? clipped : e)
  }
  return out
}

export interface PendingCommand { id: string; kind: CommandKind; args: Record<string, unknown> }

/** Store a report, refresh the heartbeat, and hand back whatever commands are waiting. */
export async function recordExtensionReport(raw: unknown, supabase: SupabaseClient = db()): Promise<{ ok: boolean; id?: string; commands: PendingCommand[]; error?: string }> {
  const r = normalizeReport(raw)
  if (!r) return { ok: false, commands: [], error: 'not a report' }
  const now = new Date().toISOString()
  let id: string | undefined
  if (r.kind !== 'heartbeat') {
    const { data, error } = await supabase.from('extension_runs').insert({
      device: r.device, kind: r.kind, site: r.site, mode: r.mode, status: r.status, reason: r.reason, source: r.source,
      started_at: r.started_at, finished_at: r.finished_at ?? r.at, counts: r.counts, log: r.log, version: r.version,
    }).select('id').single()
    if (error) return { ok: false, commands: [], error: error.message }
    id = data.id as string
  }
  const hb: Record<string, unknown> = { device: r.device, version: r.version, chrome: r.chrome, last_seen_at: now, updated_at: now }
  if (r.state) hb.state = r.state
  if (r.kind === 'run') { hb.last_run_at = r.finished_at ?? now; hb.last_run_status = r.status }
  await supabase.from('extension_heartbeat').upsert(hb, { onConflict: 'device' })
  const commands = await claimPendingCommands(supabase)
  return { ok: true, id, commands }
}

export async function claimPendingCommands(supabase: SupabaseClient = db(), limit = 10): Promise<PendingCommand[]> {
  const { data } = await supabase.from('extension_commands').select('id, kind, args').eq('status', 'pending').order('created_at', { ascending: true }).limit(limit)
  const rows = (data ?? []) as PendingCommand[]
  if (!rows.length) return []
  await supabase.from('extension_commands').update({ status: 'claimed', claimed_at: new Date().toISOString() }).in('id', rows.map(r => r.id)).eq('status', 'pending')
  return rows
}

export async function ackCommand(id: string, ok: boolean, result: unknown, supabase: SupabaseClient = db()): Promise<{ ok: boolean }> {
  await supabase.from('extension_commands').update({ status: ok ? 'done' : 'failed', finished_at: new Date().toISOString(), result: result ?? null }).eq('id', id)
  return { ok: true }
}

/** Queue a command for the extension. Validates the kind and, for set_config, the key. */
export async function enqueueExtensionCommand(kind: string, args: Record<string, unknown>, userId: string | null, supabase: SupabaseClient = db()): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!(COMMAND_KINDS as readonly string[]).includes(kind)) return { ok: false, error: `unknown command ${kind}` }
  const a: Record<string, unknown> = {}
  if (kind === 'crawl') {
    if (!['genie', 'clopay'].includes(String(args.site))) return { ok: false, error: 'crawl needs site genie|clopay' }
    if (!['full', 'incremental', 'docs'].includes(String(args.mode))) return { ok: false, error: 'crawl needs mode full|incremental|docs' }
    a.site = args.site; a.mode = args.mode
  } else if (kind === 'relogin' || kind === 'warm') {
    if (!['genie', 'clopay', 'service_fusion'].includes(String(args.site))) return { ok: false, error: 'needs site genie|clopay|service_fusion' }
    a.site = args.site
  } else if (kind === 'set_config') {
    if (!(SETTABLE_KEYS as readonly string[]).includes(String(args.key))) return { ok: false, error: `key ${args.key} cannot be set remotely` }
    const v = args.value
    if (args.key === 'pollMinutes') { const n = Number(v); if (!Number.isFinite(n) || n < 1 || n > 120) return { ok: false, error: 'pollMinutes must be 1–120' }; a.value = Math.round(n) }
    else { if (typeof v !== 'boolean') return { ok: false, error: 'value must be true or false' }; a.value = v }
    a.key = args.key
  }
  const { data, error } = await supabase.from('extension_commands').insert({ kind, args: a, created_by: userId }).select('id').single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, id: data.id as string }
}
