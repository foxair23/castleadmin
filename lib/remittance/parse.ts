// Deterministic parsers for vendor payment-remittance emails (Clopay, Overhead
// Door). Both are Oracle BI Publisher HTML tables with a stable layout, so we
// parse the HTML directly — reliable, auditable, and unit-tested against real
// sample emails (see __tests__/remittance-parse.test.ts). No AI in the money path.

export type RemittanceVendor = 'clopay' | 'overhead_door'

export interface RemittanceLine {
  /** Our PO number for the job (Clopay: "PO:NNNN" in the description; Overhead
   *  Door: the 8-digit segment before the "-" in the Document Reference Number). */
  po: string | null
  /** Customer name (Clopay only — used to validate the PO match). */
  customer_name: string | null
  /** The vendor's own line identifier (Clopay Invoice Number / OHD Document
   *  Reference Number), kept for the memo/audit trail. */
  vendor_ref: string | null
  /** Amount paid on this line. */
  amount: number
  /** Invoice/document date as printed. */
  doc_date: string | null
}

export interface ParsedRemittance {
  vendor: RemittanceVendor
  /** Payment Reference Number — goes into SF's payment reference_number. */
  payment_reference: string | null
  payment_date: string | null
  payment_amount: number | null
  lines: RemittanceLine[]
}

// ── html helpers ──────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&apos;': "'", '&quot;': '"',
}

/** Strip tags from a fragment and normalize to a single-line text value. */
function stripTags(fragment: string): string {
  let s = fragment.replace(/<[^>]*>/g, ' ')
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v)
  return s.replace(/\s+/g, ' ').trim()
}

/** All rows (each an array of cell texts) of the first table after `marker`. */
function detailRows(html: string, marker: string): string[][] {
  const at = html.indexOf(marker)
  if (at < 0) return []
  const rest = html.slice(at)
  const rows: string[][] = []
  for (const tr of rest.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(stripTags)
    rows.push(cells)
  }
  return rows
}

/** Value of the cell immediately following a labelled cell (summary tables). */
function labeledValue(html: string, label: string): string | null {
  const re = new RegExp(`${label}[\\s\\S]*?<\\/td>([\\s\\S]*?)<\\/tr>`, 'i')
  const m = html.match(re)
  if (!m) return null
  const nextCell = m[1].match(/<td[\s\S]*?<\/td>/i)
  const v = nextCell ? stripTags(nextCell[0]) : ''
  return v || null
}

/** Parse "1,535.20" / ".00" / "130.00 " → number, or NaN. */
function parseAmount(raw: string | undefined | null): number {
  if (!raw) return NaN
  const cleaned = raw.replace(/[^0-9.]/g, '')
  if (cleaned === '' || cleaned === '.') return NaN
  return Number(cleaned)
}

// ── vendor detection ──────────────────────────────────────────────────────────

export function detectVendor(fromAddr: string | null, html: string): RemittanceVendor | null {
  const from = (fromAddr ?? '').toLowerCase()
  if (from.includes('clopay.com') || /clopay payment remittance/i.test(html)) return 'clopay'
  if (from.includes('overheaddoor.com') || /overhead door corporation/i.test(html)) return 'overhead_door'
  return null
}

// ── parsers ───────────────────────────────────────────────────────────────────

/** Clopay: detail columns = [Invoice Number, Invoice Date, Invoice Description,
 *  Currency, Discount Taken, Amount Paid]. Description = "NAME PO:NNNNNNNN". */
function parseClopay(html: string): ParsedRemittance {
  const lines: RemittanceLine[] = []
  const rows = detailRows(html, 'Remittance Detail')
  for (const cells of rows) {
    if (cells.length < 6) continue
    if (cells.some(c => /^total$/i.test(c))) break
    const amount = parseAmount(cells[5])
    const vendorRef = cells[0]
    if (!Number.isFinite(amount) || !vendorRef) continue
    if (/invoice number/i.test(vendorRef)) continue // header row
    const desc = cells[2] ?? ''
    const poMatch = desc.match(/PO:\s*([0-9]+)/i)
    const po = poMatch ? poMatch[1] : null
    const customer = desc.replace(/PO:\s*[0-9]+/i, '').trim() || null
    lines.push({ po, customer_name: customer, vendor_ref: vendorRef, amount, doc_date: cells[1] || null })
  }
  return {
    vendor: 'clopay',
    payment_reference: labeledValue(html, 'Payment Reference Number'),
    payment_date: labeledValue(html, 'Payment Date'),
    payment_amount: parseAmountOrNull(labeledValue(html, 'Payment Amount')),
    lines,
  }
}

/** Overhead Door: detail columns = [Document Reference Number, Document Date,
 *  Document Amount, Currency, Amount Withheld, Discount Taken, Amount Paid].
 *  Document Reference Number = "{PO}-{their doc#}". */
function parseOverheadDoor(html: string): ParsedRemittance {
  const lines: RemittanceLine[] = []
  const rows = detailRows(html, 'Remittance Detail')
  for (const cells of rows) {
    if (cells.length < 7) continue
    if (cells.some(c => /^total$/i.test(c))) break
    const amount = parseAmount(cells[6])
    const docRef = cells[0]
    if (!Number.isFinite(amount) || !docRef) continue
    if (/document reference/i.test(docRef)) continue // header row
    const po = docRef.split('-')[0]?.trim() || null
    lines.push({ po, customer_name: null, vendor_ref: docRef, amount, doc_date: cells[1] || null })
  }
  return {
    vendor: 'overhead_door',
    payment_reference: labeledValue(html, 'Payment Reference Number'),
    payment_date: labeledValue(html, 'Payment Date'),
    payment_amount: parseAmountOrNull(labeledValue(html, 'Payment Amount')),
    lines,
  }
}

function parseAmountOrNull(raw: string | null): number | null {
  const n = parseAmount(raw)
  return Number.isFinite(n) ? n : null
}

/** Parse a remittance email's HTML for a known vendor. Returns null if unknown. */
export function parseRemittance(vendor: RemittanceVendor, html: string): ParsedRemittance {
  return vendor === 'clopay' ? parseClopay(html) : parseOverheadDoor(html)
}
