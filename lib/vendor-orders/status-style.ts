// Per-status chip colors for HD Orders (Genie / Clopay). Each distinct status
// gets its own color: curated colors for the known statuses, and a deterministic
// hash-based color for anything else so a new/unseen status still gets a distinct
// chip. Full class strings are written literally so Tailwind's scanner keeps them.

const CHIP = {
  slate: 'bg-slate-100 text-slate-700',
  gray: 'bg-gray-100 text-gray-600',
  red: 'bg-red-100 text-red-700',
  orange: 'bg-orange-100 text-orange-800',
  amber: 'bg-amber-100 text-amber-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  lime: 'bg-lime-100 text-lime-800',
  green: 'bg-green-100 text-green-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  teal: 'bg-teal-100 text-teal-800',
  cyan: 'bg-cyan-100 text-cyan-800',
  sky: 'bg-sky-100 text-sky-800',
  blue: 'bg-blue-100 text-blue-800',
  indigo: 'bg-indigo-100 text-indigo-800',
  violet: 'bg-violet-100 text-violet-800',
  purple: 'bg-purple-100 text-purple-800',
  fuchsia: 'bg-fuchsia-100 text-fuchsia-800',
  pink: 'bg-pink-100 text-pink-800',
  rose: 'bg-rose-100 text-rose-800',
} as const

// First match wins — order matters (more specific patterns before broader ones).
const RULES: Array<[RegExp, string]> = [
  [/cancel/, CHIP.red],
  [/install\s*\/?\s*delivery completed/, CHIP.gray],   // terminal
  [/install\s*\/?\s*delivery scheduled/, CHIP.teal],
  [/order received/, CHIP.blue],
  [/completed sc|sc recvd|sitecheck completed/, CHIP.emerald],
  [/sc sent/, CHIP.indigo],
  [/sc scheduled.*filter/, CHIP.fuchsia],
  [/sc scheduled/, CHIP.violet],
  [/schedule sitecheck|sitecheck scheduled|schedule sc/, CHIP.sky],
  [/awaiting/, CHIP.rose],
  [/change order/, CHIP.orange],
  [/at dc|ready for pickup|ready for delivery/, CHIP.amber],
  [/filter scheduled arrival/, CHIP.pink],
  [/scheduled arrival/, CHIP.cyan],
  [/shipped|shipment|on order/, CHIP.lime],
  [/unknown/, CHIP.slate],
  // Genie-ish generic buckets
  [/^open/, CHIP.green],
  [/^clos|complet/, CHIP.gray],
]

const HASH_PALETTE = [
  CHIP.blue, CHIP.indigo, CHIP.violet, CHIP.purple, CHIP.fuchsia, CHIP.pink,
  CHIP.teal, CHIP.cyan, CHIP.sky, CHIP.emerald, CHIP.lime, CHIP.amber,
  CHIP.orange, CHIP.rose, CHIP.yellow,
]

/** Tailwind bg/text classes for a status chip — distinct color per status. */
export function statusChipStyle(status: string | null | undefined): string {
  const k = (status || '').toLowerCase().trim()
  if (!k) return CHIP.gray
  for (const [re, c] of RULES) if (re.test(k)) return c
  let h = 0
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0
  return HASH_PALETTE[h % HASH_PALETTE.length]
}

/** True for statuses that belong in the "Completed / Cancelled" bucket. Per the
 *  Clopay rule, ONLY "Install/Delivery Completed" (and any cancelled) are terminal
 *  — other "completed"-ish statuses (e.g. "Completed SC Recvd by Clopay") are still
 *  active/in-progress. */
export function isTerminalStatus(status: string | null | undefined): boolean {
  const k = (status || '').toLowerCase()
  return /install\s*\/?\s*delivery completed/.test(k) || /cancel/.test(k)
}
