import { describe, it, expect } from 'vitest'
import { evaluateHealth, decideTransitions, type Snapshot } from '@/lib/ops/health'

// Health rules and alert transitions, on fixtures. Times are Pacific (September = PDT, UTC−7).
const T = (pt: string) => new Date(`${pt}:00-07:00`)          // 'YYYY-MM-DDTHH:MM' PT → Date
const iso = (d: Date) => d.toISOString()
const minsAgo = (now: Date, m: number) => iso(new Date(now.getTime() - m * 60_000))

function base(now: Date): Snapshot {
  return {
    now, currentVersion: '0.9.15',
    heartbeats: [{ device: 'office-mac', version: '0.9.15', last_seen_at: minsAgo(now, 3), last_run_at: minsAgo(now, 8), last_run_status: 'done', state: { enabled: true, dryRun: false, genieScheduleEnabled: true, clopayScheduleEnabled: true, clopayDocSyncEnabled: true, creds: { genie: true, clopay: true, sf: true }, alarms: ['sf-remittance-poll', 'genie-crawl', 'clopay-crawl', 'session-warm', 'ops-heartbeat'].map(name => ({ name })) } }],
    runs: [
      { id: 'r1', device: 'office-mac', kind: 'run', site: 'service_fusion', mode: null, status: 'done', reason: null, source: 'alarm', started_at: minsAgo(now, 9), finished_at: minsAgo(now, 8), counts: {}, created_at: minsAgo(now, 8) },
      { id: 'c1', device: 'office-mac', kind: 'crawl', site: 'genie', mode: 'full', status: 'done', reason: 'done', source: 'schedule', started_at: minsAgo(now, 300), finished_at: minsAgo(now, 200), counts: { detailed: 240 }, created_at: minsAgo(now, 200) },
      { id: 'c2', device: 'office-mac', kind: 'crawl', site: 'clopay', mode: 'full', status: 'done', reason: 'done', source: 'schedule', started_at: minsAgo(now, 300), finished_at: minsAgo(now, 250), counts: { detailed: 190 }, created_at: minsAgo(now, 250) },
      { id: 'd1', device: 'office-mac', kind: 'crawl', site: 'clopay', mode: 'docs', status: 'done', reason: 'done', source: 'schedule', started_at: minsAgo(now, 400), finished_at: minsAgo(now, 330), counts: { stored: 12 }, created_at: minsAgo(now, 330) },
    ],
    listRuns: [{ vendor: 'genie_thd', mode: 'incremental', received: 308, created_at: minsAgo(now, 20) }, { vendor: 'clopay_hd', mode: 'incremental', received: 192, created_at: minsAgo(now, 20) }],
    queues: [{ key: 'remittance', label: 'Remittance payments', pending: 0, oldest_at: null }, { key: 'notes', label: 'Job notes', pending: 0, oldest_at: null }],
    sfSync: ['jobs', 'estimates', 'invoices', 'calendar_tasks'].map(entity => ({ entity, status: 'completed', started_at: minsAgo(now, 120) })),
    prevStates: [], subscribers: 1, manualChecklistConfirmedAt: iso(now),
  }
}
const state = (r: ReturnType<typeof evaluateHealth>, key: string) => r.conditions.find(c => c.key === key)!.state

describe('evaluateHealth', () => {
  it('is all green on a healthy business-hours snapshot, checklist complete', () => {
    const r = evaluateHealth(base(T('2026-09-15T10:00')))
    expect(r.overall).toBe('green')
    expect(r.checklist.every(c => c.ok)).toBe(true)
  })
  it('extension silence: amber at 30 min and red at 90 min in business hours, red only after 8 h overnight', () => {
    const day = T('2026-09-15T10:00'), night = T('2026-09-15T23:30')
    const s = (now: Date, m: number) => { const b = base(now); b.heartbeats[0].last_seen_at = minsAgo(now, m); return b }
    expect(state(evaluateHealth(s(day, 45)), 'extension_silent')).toBe('amber')
    expect(state(evaluateHealth(s(day, 100)), 'extension_silent')).toBe('red')
    expect(state(evaluateHealth(s(night, 100)), 'extension_silent')).toBe('green')
    expect(state(evaluateHealth(s(night, 9 * 60)), 'extension_silent')).toBe('red')
    expect(state(evaluateHealth({ ...base(day), heartbeats: [] }), 'extension_silent')).toBe('red')
  })
  it('config: dry run or a schedule off is red; doc sync off is amber', () => {
    const b = base(T('2026-09-15T10:00'))
    ;(b.heartbeats[0].state as Record<string, unknown>).dryRun = true
    expect(state(evaluateHealth(b), 'config_off')).toBe('red')
    ;(b.heartbeats[0].state as Record<string, unknown>).dryRun = false
    ;(b.heartbeats[0].state as Record<string, unknown>).clopayDocSyncEnabled = false
    expect(state(evaluateHealth(b), 'config_off')).toBe('amber')
  })
  it('nightly full crawl: judged only after 6am; a full that ended on budget is amber, none at all red', () => {
    const early = base(T('2026-09-15T04:00'))
    early.runs = early.runs.filter(r => r.mode !== 'full')
    expect(state(evaluateHealth(early), 'genie_full_missing')).toBe('green')
    const late = base(T('2026-09-15T09:00'))
    late.runs = late.runs.map(r => r.id === 'c1' ? { ...r, status: 'budget', reason: 'budget' } : r)
    expect(state(evaluateHealth(late), 'genie_full_missing')).toBe('amber')
    late.runs = late.runs.filter(r => r.site !== 'genie')
    expect(state(evaluateHealth(late), 'genie_full_missing')).toBe('red')
  })
  it('list crawls: stale after 2.5 h (amber) and 6 h (red) in business hours only', () => {
    const day = T('2026-09-15T14:00')
    const b = base(day); b.listRuns = b.listRuns.map(l => ({ ...l, created_at: minsAgo(day, 200) }))
    expect(state(evaluateHealth(b), 'genie_list_stale')).toBe('amber')
    b.listRuns = b.listRuns.map(l => ({ ...l, created_at: minsAgo(day, 400) }))
    b.runs = b.runs.map(r => r.kind === 'crawl' ? { ...r, finished_at: minsAgo(day, 400) } : r)
    expect(state(evaluateHealth(b), 'clopay_list_stale')).toBe('red')
    const night = base(T('2026-09-15T22:00')); night.listRuns = night.listRuns.map(l => ({ ...l, created_at: minsAgo(night.now, 400) }))
    expect(state(evaluateHealth(night), 'genie_list_stale')).toBe('green')
  })

  it('list crawls: the overnight gap before the 7 AM hourly window is not stale', () => {
    // Saturday 7:00 AM digest: nightly full crawl read the list at 3 AM and finished at 5 AM.
    const seven = T('2026-09-12T07:00')
    const b = base(seven)
    b.listRuns = b.listRuns.map(l => ({ ...l, mode: 'full', created_at: minsAgo(seven, 240) }))
    b.runs = b.runs.map(r => r.kind === 'crawl' && r.mode === 'full' ? { ...r, finished_at: minsAgo(seven, 120) } : r)
    const r = evaluateHealth(b)
    expect(state(r, 'genie_list_stale')).toBe('green')
    expect(r.conditions.find(c => c.key === 'genie_list_stale')!.detail).toContain('hourly scans resume at 7 AM')
    expect(r.overall).toBe('green')
    // Same snapshot later in the morning with no hourly scan yet: amber at 9:45, red by 1:30 PM.
    const late = base(T('2026-09-12T09:45'))
    late.listRuns = late.listRuns.map(l => ({ ...l, created_at: minsAgo(seven, 240) }))
    late.runs = late.runs.map(r => r.kind === 'crawl' && r.mode === 'full' ? { ...r, finished_at: minsAgo(seven, 120) } : r)
    expect(state(evaluateHealth(late), 'genie_list_stale')).toBe('amber')
    const noon = { ...late, now: T('2026-09-12T13:30') }
    expect(state(evaluateHealth(noon), 'genie_list_stale')).toBe('red')
  })
  it('login: one failure amber, two red, a later success clears it', () => {
    const now = T('2026-09-15T10:00')
    const b = base(now)
    const fail = (id: string, m: number) => ({ id, device: 'office-mac', kind: 'login', site: 'clopay', mode: null, status: 'failed', reason: 'oidc-callback-error', source: null, started_at: null, finished_at: minsAgo(now, m), counts: null, created_at: minsAgo(now, m) })
    b.runs = [fail('l1', 5), ...b.runs]
    expect(state(evaluateHealth(b), 'login_failed:clopay')).toBe('amber')
    b.runs = [fail('l2', 2), ...b.runs]
    expect(state(evaluateHealth(b), 'login_failed:clopay')).toBe('red')
    b.runs = [{ ...fail('ok', 1), status: 'ok', reason: null }, ...b.runs]
    expect(state(evaluateHealth(b), 'login_failed:clopay')).toBe('green')
  })
  it('queues: amber past 6 h, red past 24 h', () => {
    const now = T('2026-09-15T10:00')
    const b = base(now); b.queues = [{ key: 'notes', label: 'Job notes', pending: 3, oldest_at: minsAgo(now, 7 * 60) }]
    expect(state(evaluateHealth(b), 'queue_stale:notes')).toBe('amber')
    b.queues[0].oldest_at = minsAgo(now, 25 * 60)
    expect(state(evaluateHealth(b), 'queue_stale:notes')).toBe('red')
  })
  it('flags two machines reporting in the same hour', () => {
    const b = base(T('2026-09-15T10:00'))
    b.heartbeats.push({ ...b.heartbeats[0], device: 'office-chromebook' })
    expect(state(evaluateHealth(b), 'two_devices')).toBe('amber')
  })
})

describe('decideTransitions', () => {
  const now = T('2026-09-15T10:00')
  const red = { at: iso(now), overall: 'red' as const, cards: [], checklist: [], conditions: [{ key: 'extension_silent', card: 'extension', state: 'red' as const, detail: 'silent' }] }
  const green = { ...red, overall: 'green' as const, conditions: [{ ...red.conditions[0], state: 'green' as const, detail: 'back' }] }
  it('emails when a condition turns red, not again inside the cooldown, again after it', () => {
    const first = decideTransitions([], red, now)
    expect(first.alerts).toEqual([{ condition: 'extension_silent', kind: 'red', detail: 'silent' }])
    const soon = decideTransitions(first.states, red, new Date(now.getTime() + 2 * 3_600_000))
    expect(soon.alerts).toEqual([])
    const later = decideTransitions(first.states, red, new Date(now.getTime() + 7 * 3_600_000))
    expect(later.alerts.map(a => a.kind)).toEqual(['red'])
  })
  it('emails recovered only after a red email went out, and keeps "since" across unchanged states', () => {
    const first = decideTransitions([], red, now)
    const rec = decideTransitions(first.states, green, new Date(now.getTime() + 3_600_000))
    expect(rec.alerts).toEqual([{ condition: 'extension_silent', kind: 'recovered', detail: 'back' }])
    expect(rec.states[0].last_alerted_at).toBeNull()
    const quiet = decideTransitions(rec.states, green, new Date(now.getTime() + 2 * 3_600_000))
    expect(quiet.alerts).toEqual([])
    expect(quiet.states[0].since).toBe(rec.states[0].since)
    // Green from nothing: no email.
    expect(decideTransitions([], green, now).alerts).toEqual([])
  })
})
