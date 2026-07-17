// Vercel cron schedules run on fixed UTC, so a fixed schedule drifts by an hour
// when Pacific time flips between PDT (UTC-7) and PST (UTC-8). To pin a cron to
// a PT wall-clock hour year-round, schedule it to fire at BOTH candidate UTC
// hours (e.g. "0 14,15 * * 1-6" for 7 AM PT) and call this guard at the top of
// the handler: it proceeds only on the firing that lands on the intended PT
// hour and no-ops on the other. One of the two firings always matches,
// regardless of the current DST offset.

/** Current hour (0–23) on the America/Los_Angeles wall clock. */
export function currentPtHour(): number {
  const h = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      hour12: false,
    }).format(new Date())
  )
  // Some runtimes render midnight as "24"; normalize to 0.
  return h % 24
}

/** True when it is `targetHour` (0–23) right now in Pacific time. */
export function isPtHour(targetHour: number): boolean {
  return currentPtHour() === targetHour
}
