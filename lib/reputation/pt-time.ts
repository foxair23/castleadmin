import { WEEKDAYS, type WeekdayKey } from './settings'

// Pacific wall-clock helpers for the send scheduler. Same Intl technique as
// lib/cron/pt-gate.ts (no timezone library in this project). All dateKeys are
// 'YYYY-MM-DD' on the America/Los_Angeles calendar.

export interface PtParts {
  year: number; month: number; day: number
  hour: number; minute: number; second: number
  weekday: WeekdayKey
  dateKey: string
  minutesOfDay: number
}

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  weekday: 'short',
})

const WD: Record<string, WeekdayKey> = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' }

export function ptParts(d: Date): PtParts {
  const p: Record<string, string> = {}
  for (const part of FMT.formatToParts(d)) if (part.type !== 'literal') p[part.type] = part.value
  const hour = Number(p.hour) % 24 // some runtimes render midnight as "24"
  const year = Number(p.year), month = Number(p.month), day = Number(p.day)
  const minute = Number(p.minute), second = Number(p.second)
  return {
    year, month, day, hour, minute, second,
    weekday: WD[p.weekday] ?? 'sun',
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minutesOfDay: hour * 60 + minute,
  }
}

export const ptDateKey = (d: Date): string => ptParts(d).dateKey

/** The instant at which the PT wall clock reads dateKey + minutesOfDay (+ seconds). DST-safe. */
export function ptWallToUtc(dateKey: string, minutesOfDay: number, seconds = 0): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  const h = Math.floor(minutesOfDay / 60), min = minutesOfDay % 60
  const wall = Date.UTC(y, m - 1, d, h, min, seconds)
  let guess = wall
  // Render the guess in PT and shift by how far it lands from the target wall
  // time; a second pass covers a DST edge.
  for (let i = 0; i < 2; i++) {
    const p = ptParts(new Date(guess))
    const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    const diff = rendered - wall
    if (diff === 0) break
    guess -= diff
  }
  return new Date(guess)
}

/** Calendar arithmetic on a dateKey (no timezone involved). */
export function addPtDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

export function weekdayOf(dateKey: string): WeekdayKey {
  const [y, m, d] = dateKey.split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

/** "9:02 AM" style label in PT for the admin UI. */
export function fmtPt(d: Date | string, withDate = true): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    ...(withDate ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit',
  })
}
