// Shared name cleanup — the logic used by the Mailchimp marketing export, so
// reminders and exports format customer names identically.
//
// Handles two messes in the SF data:
//   1. Reversed names — SF sometimes stores "first_name = 'Watts,'" / "last_name
//      = 'Rian'". A trailing comma on the first name is the tell; swap them.
//   2. ALL-CAPS names — title-case them, keeping McX / MacX and lowercase
//      particles (van, de, la, …).

export function fixCaps(s: string | null): string | null {
  if (!s) return s
  // Only touch strings that are entirely uppercase letters.
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s
  return s
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bMc([a-z])/g, (_, c) => `Mc${c.toUpperCase()}`)
    .replace(/\bMac([bcdfghjklmnpqrstvwxyz])/g, (_, c) => `Mac${c.toUpperCase()}`)
    .replace(/(?<=\S\s)(Van|Von|De|Di|La|Le|Du)\b/g, p => p.toLowerCase())
}

/** Clean a contact's first/last, fixing the reversed-name case and ALL-CAPS. */
export function cleanContactName(firstName: string | null, lastName: string | null): { first: string | null; last: string | null } {
  let f = firstName ?? null
  let l = lastName ?? null
  if (f && f.trimEnd().endsWith(',')) {
    const tmp = l
    l = f.trimEnd().replace(/,$/, '').trim() || null
    f = tmp
  }
  return { first: fixCaps(f), last: fixCaps(l) }
}

/**
 * Best first name for a greeting. Prefers the contact first/last fields (cleaned
 * as above); falls back to parsing a display string like "Watts, Rian" (comma =
 * "Last, First") or "Rian Watts". Returns null if nothing usable.
 */
export function greetingFirstName(opts: {
  firstName?: string | null
  lastName?: string | null
  customerName?: string | null
}): string | null {
  const { first } = cleanContactName(opts.firstName ?? null, opts.lastName ?? null)
  if (first) return first

  const name = (opts.customerName ?? '').trim()
  if (!name) return null
  if (name.includes(',')) {
    const after = name.split(',')[1]?.trim() ?? ''
    if (after) return fixCaps(after.split(/\s+/)[0]) // first token after the comma
  }
  return fixCaps(name.split(/\s+/)[0]) // first token
}
