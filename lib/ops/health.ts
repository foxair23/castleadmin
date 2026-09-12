import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Automation health: one snapshot of everything the office extension touches, one pure
// evaluation into green / amber / red per condition, and one pure decision about which
// conditions deserve an email (on turning red, on staying red past the cooldown, and on
// recovering). The Health page renders the evaluation; the cron acts on the transitions.
// All clock logic is Pacific.

export type Colour = 'green' | 'amber' | 'red'
export interface Condition { key: string; card: string; state: Colour; detail: string; since?: string | null }
export interface HealthReport {
  at: string
  overall: Colour
  conditions: Condition[]
  cards: Array<{ key: string; label: string; state: Colour; lines: string[] }>
  checklist: Array<{ key: string; label: string; ok: boolean; detail?: string }>
}

export interface Snapshot {
  now: Date
  heartbeats: Array<{ device: string; version: string | null; last_seen_at: string; last_run_at: string | null; last_run_status: string | null; state: Record<string, unknown> | null }>
  runs: Array<{ id: string; device: string | null; kind: string; site: string | null; mode: string | null; status: string; reason: string | null; source: string | null; started_at: string | null; finished_at: string | null; counts: Record<string, unknown> | null; created_at: string }>
  listRuns: Array<{ vendor: string; mode: string | null; received: number; created_at: string }>
  queues: Array<{ key: string; label: string; pending: number; oldest_at: string | null }>
  sfSync: Array<{ entity: string; status: string; started_at: string }>
  prevStates: Array<{ condition: string; state: string; since: string; last_alerted_at: string | null }>
  subscribers: number
  manualChecklistConfirmedAt: string | null
  currentVersion: string
}

const TZ = 'America/Los_Angeles'
export function ptParts(d: Date): { hour: number; minute: number; weekday: string; date: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]))
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}` }
}
const H = 3_600_000
const ageMs = (iso: string | null | undefined, now: Date) => iso ? now.getTime() - new Date(iso).getTime() : Infinity
const ago = (iso: string | null | undefined, now: Date) => {
  if (!iso) return 'never'
  const m = Math.round(ageMs(iso, now) / 60_000)
  if (m < 60) return `${m} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
  return `${Math.round(m / 1440)} d ago`
}
const worst = (a: Colour, b: Colour): Colour => (a === 'red' || b === 'red') ? 'red' : (a === 'amber' || b === 'amber') ? 'amber' : 'green'

export const REQUIRED_ALARMS = ['sf-remittance-poll', 'genie-crawl', 'clopay-crawl', 'session-warm', 'ops-heartbeat']

export function evaluateHealth(s: Snapshot): HealthReport {
  const now = s.now
  const { hour, minute, weekday, date: today } = ptParts(now)
  // The extension's hourly list crawls run 7 AM–6 PM; overnight there is only the full
  // backfill (3–6 AM). So a list-freshness clock cannot start before 7 AM, or the 7 AM
  // digest flags every morning for the overnight gap.
  const HOURLY_START = 7
  const sinceHourlyWindow = Math.max(0, ((hour - HOURLY_START) * 60 + minute) * 60_000)
  const business = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(weekday) && hour >= 6 && hour < 19
  const conds: Condition[] = []
  const add = (key: string, card: string, state: Colour, detail: string) => conds.push({ key, card, state, detail })

  // ── Extension ──
  const hb = [...s.heartbeats].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))[0] ?? null
  const hbAge = hb ? ageMs(hb.last_seen_at, now) : Infinity
  const silentRed = business ? 90 * 60_000 : 8 * H
  add('extension_silent', 'extension', hbAge > silentRed ? 'red' : (business && hbAge > 30 * 60_000) ? 'amber' : 'green',
    hb ? `${hb.device} last seen ${ago(hb.last_seen_at, now)} (v${hb.version ?? '?'})` : 'no heartbeat ever received')
  const st = (hb?.state ?? {}) as Record<string, unknown>
  const flagsOff: string[] = []
  if (hb && st.enabled === false) flagsOff.push('auto-poll OFF')
  if (hb && st.dryRun === true) flagsOff.push('dry run ON')
  if (hb && st.genieScheduleEnabled === false) flagsOff.push('Genie schedule OFF')
  if (hb && st.clopayScheduleEnabled === false) flagsOff.push('Clopay schedule OFF')
  const docsOff = hb && st.clopayDocSyncEnabled === false
  add('config_off', 'extension', flagsOff.length ? 'red' : docsOff ? 'amber' : 'green', flagsOff.length ? flagsOff.join(', ') : docsOff ? 'Clopay doc sync OFF' : 'enabled, live, both schedules on')
  const devices = new Set(s.heartbeats.filter(h => ageMs(h.last_seen_at, now) < H).map(h => h.device))
  if (devices.size > 1) add('two_devices', 'extension', 'amber', `two machines reported in the last hour: ${[...devices].join(', ')} — power one off`)
  const runsOnly = s.runs.filter(r => r.kind === 'run')
  const lastRuns = runsOnly.slice(0, 3)
  const failing = lastRuns.filter(r => r.status === 'failed').length
  add('run_failing', 'extension', lastRuns.length >= 3 && failing === 3 ? 'red' : failing >= 1 && lastRuns[0]?.status === 'failed' ? 'amber' : 'green',
    lastRuns[0] ? `last SF run ${ago(lastRuns[0].finished_at, now)}: ${lastRuns[0].status}${lastRuns[0].reason ? ` (${lastRuns[0].reason})` : ''}` : 'no SF runs reported yet')

  // ── Crawls, per vendor ──
  for (const [site, vendor, label] of [['genie', 'genie_thd', 'Genie'], ['clopay', 'clopay_hd', 'Clopay']] as const) {
    const crawls = s.runs.filter(r => r.kind === 'crawl' && r.site === site && r.mode !== 'docs')
    const lists = s.listRuns.filter(r => r.vendor === vendor)
    const lastList = lists[0] ?? null
    const listAge = lastList ? ageMs(lastList.created_at, now) : Infinity
    // Fresh = the newest of: a recorded list crawl, any crawl that completed (a full crawl
    // reads the list first, then spends hours on details), or the start of today's hourly
    // window. Before 7 AM the nightly-full rule below is the one that matters.
    const lastCrawlDone = crawls.find(r => ['done', 'budget'].includes(r.status) && r.finished_at)
    const freshness = Math.min(listAge, lastCrawlDone ? ageMs(lastCrawlDone.finished_at, now) : Infinity, sinceHourlyWindow)
    const overnightNote = listAge > 2.5 * H && freshness < listAge && sinceHourlyWindow < 2.5 * H ? ` · hourly scans resume at ${HOURLY_START} AM` : ''
    add(`${site}_list_stale`, site, business && freshness > 6 * H ? 'red' : business && freshness > 2.5 * H ? 'amber' : 'green',
      lastList ? `last list crawl ${ago(lastList.created_at, now)} · ${lastList.received} orders (${lastList.mode ?? '?'})${overnightNote}` : 'no list crawl recorded')
    const fullToday = crawls.find(r => r.mode === 'full' && r.status === 'done' && r.finished_at && ptParts(new Date(r.finished_at)).date === today)
    const fullTriedToday = crawls.find(r => r.mode === 'full' && r.finished_at && ptParts(new Date(r.finished_at)).date === today)
    const lastFullDone = crawls.find(r => r.mode === 'full' && r.status === 'done')
    add(`${site}_full_missing`, site, hour >= 6 && !fullToday ? (fullTriedToday ? 'amber' : (lastFullDone && ageMs(lastFullDone.finished_at, now) < 30 * H ? 'amber' : 'red')) : 'green',
      fullToday ? `nightly full crawl done ${ago(fullToday.finished_at, now)} · ${(fullToday.counts?.detailed as number) ?? '?'} detailed` : lastFullDone ? `last full crawl done ${ago(lastFullDone.finished_at, now)}${fullTriedToday ? ` · today's ended ${fullTriedToday.status}` : ''}` : 'no full crawl has completed yet')
    const recent = crawls.slice(0, 3)
    const stalled = recent.filter(r => ['stalled', 'hard-cap', 'error', 'no-rows', 'unclassified', 'empty-list'].includes(r.status) || ['stalled', 'hard-cap'].includes(r.reason ?? '')).length
    add(`crawl_never_finishes:${site}`, site, recent.length >= 3 && stalled === 3 ? 'red' : stalled >= 1 && recent[0] && (recent[0].status !== 'done' && recent[0].status !== 'budget') ? 'amber' : 'green',
      recent[0] ? `last crawl ${ago(recent[0].finished_at, now)}: ${recent[0].mode} → ${recent[0].reason ?? recent[0].status}` : 'no crawl reported yet')
    const logins = s.runs.filter(r => r.kind === 'login' && r.site === site).slice(0, 2)
    const lastOk = s.runs.find(r => (r.kind === 'login' && r.site === site && r.status === 'ok') || (r.kind === 'crawl' && r.site === site && ['done', 'budget'].includes(r.status)) || (r.kind === 'warm' && r.site === site && r.status === 'done'))
    const failedSince = logins.filter(r => r.status === 'failed' && (!lastOk || (r.created_at > lastOk.created_at)))
    add(`login_failed:${site}`, site, failedSince.length >= 2 ? 'red' : failedSince.length === 1 ? 'amber' : 'green',
      failedSince.length ? `auto-login failed ${failedSince.length}×: ${failedSince[0].reason ?? '?'} (${ago(failedSince[0].created_at, now)})` : `${label} session ok`)
  }
  const docs = s.runs.filter(r => r.kind === 'crawl' && r.site === 'clopay' && r.mode === 'docs')
  const lastDocsDone = docs.find(r => r.status === 'done' || r.status === 'budget')
  add('clopay_docs_stale', 'clopay_docs', lastDocsDone && ageMs(lastDocsDone.finished_at, now) < 48 * H ? 'green' : 'amber',
    lastDocsDone ? `document sync ${ago(lastDocsDone.finished_at, now)} · ${(lastDocsDone.counts?.stored as number) ?? 0} stored` : 'no document sync reported yet')

  // ── SF web session ──
  const sfLogin = s.runs.filter(r => r.kind === 'login' && r.site === 'service_fusion').slice(0, 2)
  const sfLoginFails = sfLogin.filter(r => r.status === 'failed').length
  const sfLogout = runsOnly.slice(0, 2).filter(r => /logout|logged out|session/i.test(r.reason ?? '')).length
  add('sf_session', 'sf_session', sfLoginFails >= 2 || sfLogout >= 2 ? 'red' : sfLoginFails === 1 || sfLogout === 1 ? 'amber' : 'green',
    sfLoginFails ? `SF auto-login failed: ${sfLogin[0].reason ?? '?'}` : sfLogout ? 'SF session expired during the last run' : 'Service Fusion session ok')

  // ── Queues ──
  for (const q of s.queues) {
    const age = q.oldest_at ? ageMs(q.oldest_at, now) : 0
    add(`queue_stale:${q.key}`, 'queues', q.pending && age > 24 * H ? 'red' : q.pending && age > 6 * H ? 'amber' : 'green',
      q.pending ? `${q.label}: ${q.pending} waiting, oldest ${ago(q.oldest_at, now)}` : `${q.label}: clear`)
  }

  // ── SF API sync (the app's own cron; sync-not-run already emails) ──
  const staleEntities = ['jobs', 'estimates', 'invoices', 'calendar_tasks'].filter(e => { const r = s.sfSync.find(x => x.entity === e); return !r || ageMs(r.started_at, now) > 30 * H })
  add('sf_sync_stale', 'sf_sync', staleEntities.length ? 'amber' : 'green', staleEntities.length ? `not synced in 30 h: ${staleEntities.join(', ')}` : 'all entities synced within 30 h')

  // ── Cards ──
  const CARD_LABELS: Record<string, string> = { extension: 'Extension', genie: 'Genie crawl', clopay: 'Clopay crawl', clopay_docs: 'Clopay documents', sf_session: 'SF web session', queues: 'SF write queues', sf_sync: 'SF API sync' }
  const cards = Object.entries(CARD_LABELS).map(([key, label]) => {
    const mine = conds.filter(c => c.card === key)
    return { key, label, state: mine.reduce<Colour>((a, c) => worst(a, c.state), 'green'), lines: mine.map(c => `${c.state === 'green' ? '✓' : c.state === 'amber' ? '△' : '✗'} ${c.detail}`) }
  })

  // ── Pre-departure checklist ──
  const alarms = Array.isArray(st.alarms) ? (st.alarms as Array<{ name: string }>).map(a => a.name) : []
  const creds = (st.creds ?? {}) as Record<string, boolean>
  const fullDone7d = (site: string) => s.runs.some(r => r.kind === 'crawl' && r.site === site && r.mode === 'full' && r.status === 'done' && ageMs(r.finished_at, now) < 7 * 24 * H)
  const checklist = [
    { key: 'heartbeat', label: 'Extension heartbeat in the last 15 minutes', ok: hbAge < 15 * 60_000, detail: hb ? ago(hb.last_seen_at, now) : 'none' },
    { key: 'version', label: `Extension version ${s.currentVersion}`, ok: !!hb && hb.version === s.currentVersion, detail: hb?.version ? `running ${hb.version}` : 'unknown' },
    { key: 'live', label: 'Auto-poll on, dry run off', ok: !!hb && st.enabled === true && st.dryRun === false },
    { key: 'schedules', label: 'Genie + Clopay schedules on, Clopay doc sync on', ok: !!hb && st.genieScheduleEnabled === true && st.clopayScheduleEnabled === true && st.clopayDocSyncEnabled !== false },
    { key: 'creds', label: 'Saved logins for Genie, Clopay and Service Fusion', ok: !!creds.genie && !!creds.clopay && !!creds.sf, detail: Object.entries(creds).filter(([, v]) => !v).map(([k]) => k).join(', ') || undefined },
    { key: 'alarms', label: 'All five alarms armed', ok: REQUIRED_ALARMS.every(a => alarms.includes(a)), detail: REQUIRED_ALARMS.filter(a => !alarms.includes(a)).join(', ') || undefined },
    { key: 'full_genie', label: 'A Genie full crawl completed in the last 7 days', ok: fullDone7d('genie') },
    { key: 'full_clopay', label: 'A Clopay full crawl completed in the last 7 days', ok: fullDone7d('clopay') },
    { key: 'subscribers', label: 'Someone subscribed to Automation Health emails', ok: s.subscribers > 0, detail: `${s.subscribers} subscriber(s)` },
    { key: 'manual', label: 'Machine settings confirmed (never sleep, Chrome auto-start, background apps on, extension pinned)', ok: !!s.manualChecklistConfirmedAt, detail: s.manualChecklistConfirmedAt ? `confirmed ${ago(s.manualChecklistConfirmedAt, now)}` : undefined },
  ]

  const overall = conds.reduce<Colour>((a, c) => worst(a, c.state), 'green')
  return { at: now.toISOString(), overall, conditions: conds, cards, checklist }
}

// ── Transitions → emails ────────────────────────────────────────────────────
export const ALERT_COOLDOWN_MS = 6 * H
export interface Transition { condition: string; kind: 'red' | 'recovered'; detail: string }
export interface StateRow { condition: string; state: Colour; since: string; last_alerted_at: string | null }

/** Which conditions deserve an email now, and the state rows to store. A red email fires
 *  when a condition turns red, or stays red past the cooldown since the last email. A
 *  recovered email fires only after a red one was sent for that condition and it is now
 *  green (amber is not recovery; it is not an alert either). */
export function decideTransitions(prev: Array<{ condition: string; state: string; since: string; last_alerted_at: string | null }>, report: HealthReport, now: Date): { alerts: Transition[]; states: StateRow[] } {
  const prevBy = new Map(prev.map(p => [p.condition, p]))
  const alerts: Transition[] = []
  const states: StateRow[] = []
  const nowIso = now.toISOString()
  for (const c of report.conditions) {
    const p = prevBy.get(c.key)
    const wasRed = p?.state === 'red'
    const since = p && p.state === c.state ? p.since : nowIso
    let lastAlerted = p?.last_alerted_at ?? null
    if (c.state === 'red') {
      const due = !wasRed || !lastAlerted || now.getTime() - new Date(lastAlerted).getTime() >= ALERT_COOLDOWN_MS
      if (due) { alerts.push({ condition: c.key, kind: 'red', detail: c.detail }); lastAlerted = nowIso }
    } else if (c.state === 'green' && wasRed && p?.last_alerted_at) {
      alerts.push({ condition: c.key, kind: 'recovered', detail: c.detail })
      lastAlerted = null
    }
    states.push({ condition: c.key, state: c.state, since, last_alerted_at: lastAlerted })
  }
  return { alerts, states }
}

// ── Snapshot from the database ──────────────────────────────────────────────
function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export async function loadHealthSnapshot(supabase: SupabaseClient = db(), currentVersion: string, now = new Date()): Promise<Snapshot> {
  const [hb, runs, lists, remit, notes, lines, sched, docs, sync, prev, subs, manual] = await Promise.all([
    supabase.from('extension_heartbeat').select('device, version, last_seen_at, last_run_at, last_run_status, state'),
    supabase.from('extension_runs').select('id, device, kind, site, mode, status, reason, source, started_at, finished_at, counts, created_at').order('created_at', { ascending: false }).limit(300),
    supabase.from('vendor_scrape_runs').select('vendor, mode, received, created_at').eq('kind', 'list').order('created_at', { ascending: false }).limit(60),
    supabase.from('remittance_payments').select('updated_at', { count: 'exact' }).eq('apply_status', 'approved').eq('match_status', 'matched').order('updated_at', { ascending: true }).limit(1),
    supabase.from('sf_note_queue').select('created_at', { count: 'exact' }).eq('status', 'pending').lt('attempts', 100).order('created_at', { ascending: true }).limit(1),
    supabase.from('vendor_orders').select('updated_at', { count: 'exact' }).eq('sf_lines_status', 'queued').order('updated_at', { ascending: true }).limit(1),
    supabase.from('vendor_orders').select('scheduled_at', { count: 'exact' }).eq('sf_schedule_status', 'queued').order('scheduled_at', { ascending: true }).limit(1),
    supabase.from('sf_document_upload_queue').select('created_at', { count: 'exact' }).eq('status', 'pending').order('created_at', { ascending: true }).limit(1),
    supabase.from('sf_sync_runs').select('entity, status, started_at').in('run_type', ['incremental', 'reconcile', 'backfill']).eq('status', 'completed').in('entity', ['jobs', 'estimates', 'invoices', 'calendar_tasks']).order('started_at', { ascending: false }).limit(40),
    supabase.from('ops_health_state').select('condition, state, since, last_alerted_at, detail'),
    supabase.from('user_notification_preferences').select('user_id, notification_types!inner(key)', { count: 'exact', head: true }).eq('is_enabled', true).eq('notification_types.key', 'automation_health'),
    supabase.from('ops_health_state').select('since').eq('condition', 'checklist:manual').maybeSingle(),
  ])
  const q = (key: string, label: string, r: { count: number | null; data: Array<Record<string, string | null>> | null }, col: string) => ({ key, label, pending: r.count ?? 0, oldest_at: r.data?.[0]?.[col] ?? null })
  const sfSync: Snapshot['sfSync'] = []
  for (const r of (sync.data ?? []) as Snapshot['sfSync']) if (!sfSync.some(x => x.entity === r.entity)) sfSync.push(r)
  return {
    now, currentVersion,
    heartbeats: (hb.data ?? []) as Snapshot['heartbeats'],
    runs: (runs.data ?? []) as Snapshot['runs'],
    listRuns: (lists.data ?? []) as Snapshot['listRuns'],
    queues: [
      q('remittance', 'Remittance payments', remit as never, 'updated_at'),
      q('notes', 'Job notes', notes as never, 'created_at'),
      q('lines', 'IPO line items', lines as never, 'updated_at'),
      q('schedule', 'Genie appointments', sched as never, 'scheduled_at'),
      q('docs', 'Signed forms', docs as never, 'created_at'),
    ],
    sfSync,
    prevStates: (prev.data ?? []) as Snapshot['prevStates'],
    subscribers: subs.count ?? 0,
    manualChecklistConfirmedAt: (manual.data?.since as string | null) ?? null,
  }
}

export async function saveHealthStates(states: StateRow[], report: HealthReport, supabase: SupabaseClient = db()): Promise<void> {
  const now = new Date().toISOString()
  const detailBy = new Map(report.conditions.map(c => [c.key, c.detail]))
  const rows = states.map(s => ({ condition: s.condition, state: s.state, since: s.since, last_alerted_at: s.last_alerted_at, detail: detailBy.get(s.condition) ?? null, updated_at: now }))
  if (rows.length) await supabase.from('ops_health_state').upsert(rows, { onConflict: 'condition' })
}
