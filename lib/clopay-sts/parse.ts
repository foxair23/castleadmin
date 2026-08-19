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

// An order line: order number (6–9 digits, optionally "Order #…"), then "PO",
// then the description. Matches both "Order #NNN - PO TEXT" and "NNN PO TEXT".
const LINE_RE = /(?:order\s*#?\s*)?(\d{6,9})\b[\s\-–:]*po\b[:\s/]*(.+)/i
const STS_RE = /\bsts\b/i

/** Extract the STS order lines from a (possibly forwarded) Clopay email. */
export function parseStsOrders(text: string | null, html: string | null): StsOrderLine[] {
  const body = text && text.trim() ? text : html ? stripTags(html) : ''
  const out: StsOrderLine[] = []
  const seen = new Set<string>()
  for (const rawLine of body.split(/\r?\n/)) {
    // Drop forward-quote markers ("> ") and collapse whitespace.
    const line = rawLine.replace(/^\s*>+\s?/, '').replace(/\s+/g, ' ').trim()
    if (!line || !STS_RE.test(line)) continue
    const m = line.match(LINE_RE)
    if (!m) continue
    const external_id = m[1]
    const customer_po = m[2].trim()
    // The STS marker must be in the order text itself (not merely elsewhere on the line).
    if (!STS_RE.test(customer_po)) continue
    if (seen.has(external_id)) continue
    seen.add(external_id)
    out.push({ external_id, customer_po, raw_line: line })
  }
  return out
}
