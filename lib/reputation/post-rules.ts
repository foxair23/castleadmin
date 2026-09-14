// Pure rules shared by the post drafter and the photo queue (no imports, no cycles).

export const DEFAULT_EXCLUDE = /warranty|estimate|service call|callback|call back|no charge|recall/i
export const CANCELLED_STATUSES = ['Cancelled', 'Canceled', 'Void', 'Voided']

/** Is this category allowed to become a post? An empty allow-list means everything except the usual non-work categories. */
export function categoryAllowed(category: string | null, allowed: string[]): boolean {
  const c = (category ?? '').trim()
  if (allowed.length) return allowed.some(a => a.trim().toLowerCase() === c.toLowerCase())
  return !!c && !DEFAULT_EXCLUDE.test(c)
}
