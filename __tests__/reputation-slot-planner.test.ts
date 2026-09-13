import { describe, it, expect } from 'vitest'
import { planSlot, makeRng, skippedHoursFor, humanizeMinute, type ExistingSend, type PlanInput } from '@/lib/reputation/slot-planner'
import { ptParts, ptWallToUtc } from '@/lib/reputation/pt-time'
import { DEFAULT_WORKING_WINDOW } from '@/lib/reputation/settings'
import { priorityFor } from '@/lib/reputation/queue'

const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  now: new Date('2026-09-16T17:00:00Z'), // Wed 10:00 PDT
  earliestAt: new Date('2026-09-16T17:00:00Z'),
  window: DEFAULT_WORKING_WINDOW,
  minGapMin: 20, maxGapMin: 90, skipHourRatio: 0,
  cap: 8, capBucket: () => true,
  existing: [], rng: makeRng(42),
  ...over,
})
const send = (iso: string, kind = 'review_reply', origin: string | null = 'new'): ExistingSend => ({ at: new Date(iso), kind, origin })
const okOf = (r: ReturnType<typeof planSlot>) => { if (!r.ok) throw new Error('no slot'); return r }

describe('planSlot', () => {
  it('never lands on :00/:15/:30/:45 and rarely on other multiples of 5', () => {
    let fives = 0, total = 0
    const secs = new Set<number>()
    for (let seed = 1; seed <= 500; seed++) {
      const r = okOf(planSlot(base({ rng: makeRng(seed), now: new Date(Date.UTC(2026, 8, 14, 15, 0) + seed * 7 * 60_000), earliestAt: new Date(0) })))
      const p = ptParts(r.scheduledFor)
      expect(p.minute % 15, `seed ${seed} → :${p.minute}`).not.toBe(0)
      if (p.minute % 5 === 0) fives++
      total++
      secs.add(p.second)
    }
    expect(fives / total).toBeLessThan(0.15)
    expect(secs.size).toBeGreaterThan(20)
  })

  it('waits for Monday when asked on a Sunday, and for opening when asked early', () => {
    const sun = okOf(planSlot(base({ now: new Date('2026-09-13T18:00:00Z'), earliestAt: new Date('2026-09-13T18:00:00Z') })))
    const p = ptParts(sun.scheduledFor)
    expect(p.weekday).toBe('mon')
    expect(p.minutesOfDay).toBeGreaterThanOrEqual(460)
    expect(sun.pushReasons).toContain('window')

    const early = okOf(planSlot(base({ now: new Date('2026-09-16T12:00:00Z'), earliestAt: new Date('2026-09-16T12:00:00Z') }))) // Wed 5:00 PDT
    const q = ptParts(early.scheduledFor)
    expect(q.dateKey).toBe('2026-09-16')
    expect(q.minutesOfDay).toBeGreaterThanOrEqual(460)
    expect(q.minutesOfDay).toBeLessThan(480)
  })

  it('honors earliestAt and rolls past closing to the next open day', () => {
    const later = new Date('2026-09-16T20:30:00Z') // Wed 1:30 PM PDT
    const r = okOf(planSlot(base({ earliestAt: later })))
    expect(r.scheduledFor.getTime()).toBeGreaterThanOrEqual(later.getTime())
    expect(r.scheduledFor.getTime() - later.getTime()).toBeLessThan(15 * 60_000)

    const fri = okOf(planSlot(base({ now: new Date('2026-09-19T01:30:00Z'), earliestAt: new Date('2026-09-19T01:30:00Z') }))) // Fri 6:30 PM PDT
    expect(ptParts(fri.scheduledFor).weekday).toBe('sat')
    expect(fri.pushReasons).toContain('window')
  })

  it('keeps a random gap after the previous send and before the next', () => {
    const prev = send('2026-09-16T17:00:00Z')
    const r = okOf(planSlot(base({ existing: [prev] })))
    expect(r.scheduledFor.getTime() - prev.at.getTime()).toBeGreaterThanOrEqual(20 * 60_000)
    expect(r.pushReasons).toContain('spacing')

    const next = send('2026-09-16T17:10:00Z') // 10 min after the cursor
    const r2 = okOf(planSlot(base({ existing: [next] })))
    expect(r2.scheduledFor.getTime()).toBeGreaterThan(next.at.getTime() + 19 * 60_000)
  })

  it('enforces the daily cap per bucket only', () => {
    const today = Array.from({ length: 8 }, (_, i) => send(`2026-09-16T${String(15 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '35' : '05'}:00Z`))
    const capped = okOf(planSlot(base({ existing: today, cap: 8, capBucket: e => e.origin === 'new' })))
    expect(ptParts(capped.scheduledFor).dateKey).toBe('2026-09-17')
    expect(capped.pushReasons).toContain('cap')

    const backlogOnly = okOf(planSlot(base({ existing: today, cap: 3, capBucket: e => e.origin === 'backlog' })))
    expect(ptParts(backlogOnly.scheduledFor).dateKey).toBe('2026-09-16')

    const reminder = okOf(planSlot(base({ existing: today, cap: null })))
    expect(ptParts(reminder.scheduledFor).dateKey).toBe('2026-09-16')
  })

  it('hops out of a dead hour', () => {
    const key = '2026-09-16'
    const skipped = skippedHoursFor(key, 460, 1100, 0.5)
    const hour = [...skipped][0]
    const at = ptWallToUtc(key, hour * 60 + 10)
    const r = okOf(planSlot(base({ now: at, earliestAt: at, skipHourRatio: 0.5 })))
    expect(ptParts(r.scheduledFor).hour).not.toBe(hour)
    expect(skipped.has(ptParts(r.scheduledFor).hour)).toBe(false)
    expect(r.pushReasons).toContain('gap_hour')
  })

  it('returns no_slot when every day is closed', () => {
    const closed = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }
    expect(planSlot(base({ window: closed }))).toEqual({ ok: false, reason: 'no_slot' })
  })
})

describe('skippedHoursFor / humanizeMinute / makeRng', () => {
  it('is deterministic per day, never the opening hour, empty at ratio 0', () => {
    const a = skippedHoursFor('2026-09-16', 460, 1100, 0.25)
    const b = skippedHoursFor('2026-09-16', 460, 1100, 0.25)
    expect([...a]).toEqual([...b])
    expect(a.size).toBe(3) // 8..17 = 10 candidate hours × 0.25 → 3
    expect(a.has(7)).toBe(false)
    expect(skippedHoursFor('2026-09-16', 460, 1100, 0).size).toBe(0)
    expect([...skippedHoursFor('2026-09-17', 460, 1100, 0.25)]).not.toEqual([...a])
  })
  it('moves quarter-hours always and fives usually', () => {
    const rng = makeRng(7)
    for (const m of [0, 15, 30, 45]) { const h = humanizeMinute(m, rng); expect(h).toBeGreaterThan(m); expect(h - m).toBeLessThanOrEqual(4) }
    expect(humanizeMinute(17, rng)).toBe(17)
  })
  it('is reproducible', () => {
    const a = makeRng('seed'), b = makeRng('seed')
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('priorityFor', () => {
  it('orders new negative, new positive, reminders, posts, backlog', () => {
    expect(priorityFor('review_reply', 'negative', 'new')).toBe(1)
    expect(priorityFor('review_reply', 'positive', 'new')).toBe(2)
    expect(priorityFor('csat_reminder', null, null)).toBe(3)
    expect(priorityFor('gbp_post', null, null)).toBe(4)
    expect(priorityFor('review_reply', 'negative', 'backlog')).toBe(5)
  })
})
