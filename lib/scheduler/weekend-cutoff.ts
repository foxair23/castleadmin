// Weekend cutoff rule for the public scheduler: after Friday 4:00 PM PT,
// the following Monday's MORNING window (any window starting before noon)
// can no longer be booked — there's nobody in the office over the weekend to
// confirm/staff a first-thing-Monday appointment. Enforced in both the
// availability endpoint (slot greys out) and the bookings endpoint (a widget
// left open since before the cutoff can't submit a stale slot).

/** Interpret a PT wall-clock date+time as a UTC Date (same offset technique
 *  as the scheduler routes). */
export function laWallClockToUtc(date: string, time: string): Date {
  const candidate = new Date(`${date}T${time}:00`)
  const laMs = new Date(candidate.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).getTime()
  const offset = candidate.getTime() - laMs
  return new Date(candidate.getTime() + offset)
}

/** True when `appointmentDate` is a Monday, the window starts before noon,
 *  and `nowMs` is past 4 PM PT of the preceding Friday. */
export function isMondayMorningLockedOut(appointmentDate: string, windowStart: string, nowMs: number): boolean {
  if (windowStart >= '12:00') return false
  const target = new Date(appointmentDate + 'T00:00:00Z')
  if (target.getUTCDay() !== 1) return false // Mondays only
  const friday = new Date(target)
  friday.setUTCDate(friday.getUTCDate() - 3)
  const cutoff = laWallClockToUtc(friday.toISOString().slice(0, 10), '16:00')
  return nowMs >= cutoff.getTime()
}
