import type { WorkingWindow } from './settings'
import { addPtDays, ptParts, ptWallToUtc, weekdayOf } from './pt-time'

// The humanized send-time planner (PRD §4.5). Pure: given the rules, what is
// already scheduled, and a seeded random source, it returns when one more thing
// should go out. It never sends at the moment something was approved; it finds
// a time inside the working window, at least a random gap away from any other
// send, outside that day's randomly skipped hours, under the daily cap, and then
// nudges the minute off :00/:15/:30/:45 (and usually off multiples of 5) with
// random seconds, so timestamps look like 9:02:41 and 10:28:17.

export interface ExistingSend { at: Date; kind: string; origin: string | null }

export interface PlanInput {
  now: Date
  earliestAt: Date
  window: WorkingWindow
  minGapMin: number
  maxGapMin: number
  skipHourRatio: number
  /** Daily cap for this item's bucket, or null when uncapped. */
  cap: number | null
  /** Which existing sends count against that cap. */
  capBucket: (e: ExistingSend) => boolean
  existing: ExistingSend[]
  rng: () => number
  maxDaysAhead?: number
}

export type PushReason = 'window' | 'cap' | 'spacing' | 'gap_hour'
export type PlanResult =
  | { ok: true; scheduledFor: Date; pushReasons: PushReason[] }
  | { ok: false; reason: 'no_slot' }

const MIN = 60_000

// ── Random ─────────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

/** Deterministic [0,1) generator (mulberry32) from a string or number seed. */
export function makeRng(seed: number | string): () => number {
  let a = typeof seed === 'number' ? seed >>> 0 : fnv1a(seed)
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Pieces ─────────────────────────────────────────────────────────────────

/**
 * Which whole hours inside [open, close) are dead on this PT day. Seeded from the
 * date so every planner call that day agrees. Never the opening hour, so a
 * morning after a closed day still has somewhere to go.
 */
export function skippedHoursFor(dateKey: string, openMin: number, closeMin: number, ratio: number): Set<number> {
  const first = Math.floor(openMin / 60) + 1
  const last = Math.ceil(closeMin / 60) - 1
  const hours: number[] = []
  for (let h = first; h <= last; h++) hours.push(h)
  const n = Math.min(hours.length, Math.max(0, Math.round(Math.max(0, Math.min(0.9, ratio)) * hours.length)))
  if (n === 0) return new Set()
  const rng = makeRng(`skip:${dateKey}`)
  for (let i = hours.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [hours[i], hours[j]] = [hours[j], hours[i]] }
  return new Set(hours.slice(0, n))
}

/** Move a minute off :00/:15/:30/:45 always, and off other multiples of 5 nine times in ten. May return >= 60. */
export function humanizeMinute(minute: number, rng: () => number): number {
  if (minute % 15 === 0) return minute + 1 + Math.floor(rng() * 4)
  if (minute % 5 === 0 && rng() < 0.9) return minute + 1 + Math.floor(rng() * 4)
  return minute
}

// ── Planner ────────────────────────────────────────────────────────────────

export function planSlot(input: PlanInput): PlanResult {
  const { window, minGapMin, maxGapMin, skipHourRatio, cap, capBucket, rng } = input
  const maxDays = input.maxDaysAhead ?? 14
  const gapMin = Math.max(1, minGapMin)
  const gapMax = Math.max(gapMin, maxGapMin)
  const randomGap = () => (gapMin + rng() * (gapMax - gapMin)) * MIN

  const t = new Date(Math.max(input.now.getTime(), input.earliestAt.getTime()))
  const existing = [...input.existing].sort((a, b) => a.at.getTime() - b.at.getTime())
  const push = new Set<PushReason>()
  const startKey = ptParts(t).dateKey

  for (let off = 0; off <= maxDays; off++) {
    const key = addPtDays(startKey, off)
    const win = window[weekdayOf(key)]
    if (!win) { push.add('window'); continue }
    const [open, close] = win

    if (cap != null) {
      const used = existing.filter(capBucket).filter(e => ptParts(e.at).dateKey === key).length
      if (used >= cap) { push.add('cap'); continue }
    }

    const skipped = skippedHoursFor(key, open, close, skipHourRatio)
    const openAt = ptWallToUtc(key, open)
    const closeAt = ptWallToUtc(key, close)
    let cursor = off === 0 ? Math.max(t.getTime(), openAt.getTime()) : openAt.getTime()
    if (off === 0 && t.getTime() < openAt.getTime()) push.add('window')

    for (let iter = 0; iter < 40; iter++) {
      let moved = false
      // Keep a random gap after the previous send.
      let prev: ExistingSend | null = null
      for (const e of existing) { if (e.at.getTime() <= cursor) prev = e; else break }
      if (prev) {
        const gap = randomGap()
        if (cursor - prev.at.getTime() < gap) { cursor = prev.at.getTime() + gap; push.add('spacing'); moved = true }
      }
      // And at least the minimum gap before the next one.
      const next = existing.find(e => e.at.getTime() > cursor) ?? null
      if (next && next.at.getTime() - cursor < gapMin * MIN) {
        cursor = next.at.getTime() + randomGap(); push.add('spacing'); moved = true
      }
      // Hop out of a dead hour.
      const p = ptParts(new Date(cursor))
      if (p.dateKey === key && skipped.has(p.hour)) {
        cursor = ptWallToUtc(key, (p.hour + 1) * 60).getTime() + rng() * 10 * MIN
        push.add('gap_hour'); moved = true
      }
      if (!moved) break
    }

    if (cursor >= closeAt.getTime()) { push.add('window'); continue }

    // Humanize the minute and seconds.
    const p = ptParts(new Date(cursor))
    let m = humanizeMinute(p.minute, rng)
    let h = p.hour
    if (m >= 60) { m -= 60; h += 1 }
    const sec = Math.floor(rng() * 60)
    let cand = ptWallToUtc(key, h * 60 + m, sec)
    if (cand.getTime() >= closeAt.getTime()) {
      // Slipped past closing: step back a few odd minutes instead.
      let back = close - 7 - Math.floor(rng() * 5)
      if (back % 5 === 0) back -= 1 + Math.floor(rng() * 3)
      cand = ptWallToUtc(key, back, sec)
    }
    return { ok: true, scheduledFor: cand, pushReasons: [...push] }
  }
  return { ok: false, reason: 'no_slot' }
}
