// Parse Clopay "ISTORE ORDER(S)" emails for ship-to-store (STS) order lines.
// Clopay mixes STS and non-STS orders in one email; the ONLY marker is the token
// "STS" in the order's PO/description. Deterministic + line-based (no AI) —
// mirrors lib/remittance/parse.ts and lib/leadgen/parse.ts.

export interface StsOrderLine {
  external_id: string   // the order number (e.g. '181191036')
  customer_po: string   // the PO/description text (e.g. 'STS ALEXANDER #680')
  raw_line: string
}

// Strip HTML to text, but turn block boundaries into newlines first so each
// order stays on its own line for the line parser.
function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(tr|p|div|li|h[1-6]|td)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
}

// An order's marker: the order number (6–9 digits, optionally "Order #…") followed by "PO".
// Used with matchAll so SEVERAL orders on ONE line are split apart — Clopay's ROLLUP emails
// arrive that way when the forward collapses the list, and treating the run as one order
// swallowed two of them into the first one's PO text (18 Sep: 181195300 carried 181195102
// and 181195383 in its description, so the STS tab showed one row where the DC had three).
const ORDER_RE = /(?:order\s*#?\s*)?(\d{6,9})\b[\s\-–:]*po\b[:\s/]*/gi
const STS_RE = /\bsts\b/i

// Clopay's sign-off runs on after the last order when the list is collapsed onto one line.
// Cut it, or the final order's PO ends "...STS 1848 Thank you for your order, we appreciate
// your business. San Diego Team.?".
const TRAILING_RE = /\s*\b(?:thank you|thanks|please (?:email|call|note)|door\(s\) will be held|we appreciate your business|san diego team|regards|sincerely|hello)\b[\s\S]*$/i

/** Every order named on one line of text, in order. */
function ordersOnLine(line: string): Array<{ external_id: string; customer_po: string }> {
  const marks = [...line.matchAll(ORDER_RE)]
  const out: Array<{ external_id: string; customer_po: string }> = []
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]
    const from = (m.index ?? 0) + m[0].length
    // The description runs to the next order's marker, or to the end of the line.
    const to = i + 1 < marks.length ? marks[i + 1].index ?? line.length : line.length
    const customer_po = line.slice(from, to).replace(TRAILING_RE, '').replace(/[\s,;:.-]+$/, '').trim()
    if (customer_po) out.push({ external_id: m[1], customer_po })
  }
  return out
}

/** Extract the STS order lines from a (possibly forwarded) Clopay email. */
export function parseStsOrders(text: string | null, html: string | null): StsOrderLine[] {
  const body = text && text.trim() ? text : html ? stripTags(html) : ''
  const out: StsOrderLine[] = []
  const seen = new Set<string>()
  for (const rawLine of body.split(/\r?\n/)) {
    // Drop forward-quote markers ("> ") and collapse whitespace.
    const line = rawLine.replace(/^\s*>+\s?/, '').replace(/\s+/g, ' ').trim()
    if (!line || !STS_RE.test(line)) continue
    for (const o of ordersOnLine(line)) {
      // The STS marker must be in the order's OWN text, not merely elsewhere on the line —
      // which matters more now that one line can carry several orders.
      if (!STS_RE.test(o.customer_po)) continue
      if (seen.has(o.external_id)) continue
      seen.add(o.external_id)
      out.push({ ...o, raw_line: line })
    }
  }
  return out
}
