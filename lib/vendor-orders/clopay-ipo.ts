// Clopay "Installer Purchase Order" (IPO) parsing.
//
// The IPO is the document that says what the work is and WHAT CASTLE GETS PAID: a table of
// line items (qty, item number, description, fee) plus a document total. Clopay generates
// them from Oracle, so the layout is highly regular — a deterministic parser handles it and
// the document's own `TOTAL :` line doubles as a checksum (sum of line fees must equal it),
// which makes a bad parse visible instead of silently wrong.
//
// Extracted text looks like:
//   LINE / NO. / QTY / ORD. / ITEM / NUMBER / DESCRIPTION TOTAL FEE
//   1.1 1 DC13 DC13 - CLOPAY POLYSTYRENE ; URETHANE
//                    WIDTH X HEIGHT : 15ft X 7ft          ← description wraps
//                    $0.00                                ← fee may sit on its own line
//   2.1 1 FIR670 DOUBLE CAR DOOR DELIVERY CHARGE $100.00   ← or end the item line
//   TOTAL : $100.00
// Product lines (door/opener/molding) are $0.00; the money is on FIR* labor/delivery lines.
// Item numbers occasionally wrap across lines (e.g. "CAN212-" / "CD*R49892" / "0").
//
// CRITICAL: one PDF can contain SEVERAL complete IPOs — one per page, each with its own
// Order Number, PO Number and TOTAL (a multi-door job; the footer numbers them, e.g.
// "…-IP-01-03" = 1 of 3). Clopay attaches the whole bundle to every order in the group, so
// the page order does NOT correspond to the order the document hangs off. Parsing only the
// first TOTAL silently attributed a sibling door's money to the wrong order (real case:
// EASTMAN KAREN order 181194157 showed $458.00, its sibling's total, instead of $532.00).
// Always use parseIpoDocument() and match sections by their own orderNumber.

export interface IpoLine {
  line_no: string
  quantity: number
  item_number: string
  description: string
  line_fee: number
}

export interface IpoParseResult {
  orderNumber: string | null
  poNumber: string | null
  orderDate: string | null
  items: IpoLine[]
  totalFee: number | null
  /** sum(line fees) === the document's stated TOTAL — the built-in correctness check. */
  ok: boolean
}

/** Is this stored document an IPO? `docType` is Clopay's documenT_TYPE ("New IPO"); the
 *  filename convention is the IP_ prefix. Either is sufficient. */
export function isIpoDoc(filename: string | null | undefined, docType?: string | null): boolean {
  if (docType && /\bIPO\b/i.test(docType)) return true
  return /(^|[/-])IP_/i.test(filename ?? '')
}

const ITEM_RE = /^(\d+\.\d+)\s+(\d+)\s+(.*)$/
const FEE_RE = /\$\s*([\d,]+\.\d{2})\s*$/
const TOTAL_RE = /^TOTAL\s*:\s*\$\s*([\d,]+\.\d{2})/i
const money = (s: string) => Number(s.replace(/,/g, ''))

/** 'MM/DD/YYYY' → 'YYYY-MM-DD' (the format the IPO header uses), else null. */
function toIsoDate(s: string | null): string | null {
  const m = (s ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null
}
function headerValue(text: string, label: string): string | null {
  const m = text.match(new RegExp(`${label}\\s*:\\s*(.*)`, 'i'))
  const v = m?.[1]?.trim()
  return v ? v : null
}

/** Split a document into its per-order IPO sections and parse each one. A single-IPO
 *  document yields one section. Sections are returned in page order; callers must pick the
 *  one whose `orderNumber` matches the order they are storing against — never index [0]. */
export function parseIpoDocument(text: string): IpoParseResult[] {
  const src = text ?? ''
  // Each embedded IPO starts its own header block with "Order Number:".
  const starts: number[] = []
  const re = /Order Number\s*:/gi
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push(m.index)
  if (starts.length <= 1) {
    const one = parseIpoText(src)
    return one.items.length > 0 || one.orderNumber ? [one] : []
  }
  const out: IpoParseResult[] = []
  for (let i = 0; i < starts.length; i++) {
    const section = src.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined)
    const parsed = parseIpoText(section)
    if (parsed.items.length > 0 || parsed.orderNumber) out.push(parsed)
  }
  return out
}

/** Find the section belonging to one order number (the order a document is attached to). */
export function sectionForOrder(sections: IpoParseResult[], orderNumber: string): IpoParseResult | null {
  return sections.find(s => s.orderNumber === orderNumber) ?? null
}

/** Parse ONE IPO section (a single order's header + line-item table). Use
 *  parseIpoDocument() for whole PDFs — they may contain several of these. */
export function parseIpoText(text: string): IpoParseResult {
  const lines = (text ?? '').split('\n').map(l => l.trimEnd())
  const empty: IpoParseResult = {
    orderNumber: headerValue(text, 'Order Number'),
    poNumber: headerValue(text, 'PO Number'),
    orderDate: toIsoDate(headerValue(text, 'Order Date')),
    items: [], totalFee: null, ok: false,
  }

  // The table header is the line carrying both DESCRIPTION and TOTAL FEE.
  const start = lines.findIndex(l => l.includes('DESCRIPTION') && /TOTAL\s+FEE/i.test(l))
  if (start < 0) return empty

  const items: IpoLine[] = []
  let totalFee: number | null = null
  let cur: { line_no: string; quantity: number; item_number: string; parts: string[]; line_fee: number | null } | null = null
  const close = () => {
    if (!cur) return
    items.push({
      line_no: cur.line_no,
      quantity: cur.quantity,
      item_number: cur.item_number,
      description: cur.parts.join(' ').replace(/\s+/g, ' ').trim(),
      line_fee: cur.line_fee ?? 0,
    })
    cur = null
  }

  for (const raw of lines.slice(start + 1)) {
    const s = raw.trim()
    if (!s) continue

    const t = s.match(TOTAL_RE)
    if (t) { close(); totalFee = money(t[1]); break }

    const m = s.match(ITEM_RE)
    if (m) {
      close()
      let rest = m[3].trim()
      let fee: number | null = null
      const fm = rest.match(FEE_RE)
      if (fm) { fee = money(fm[1]); rest = rest.slice(0, fm.index).trim() }
      const sp = rest.indexOf(' ')
      const itemNumber = sp === -1 ? rest : rest.slice(0, sp)
      const desc = sp === -1 ? '' : rest.slice(sp + 1).trim()
      cur = { line_no: m[1], quantity: Number(m[2]), item_number: itemNumber, parts: desc ? [desc] : [], line_fee: fee }
      if (fee !== null) close()
      continue
    }

    if (!cur) continue // stray text between the header and the first item
    const fm = s.match(FEE_RE)
    if (fm) {
      const pre = s.slice(0, fm.index).trim()
      if (pre) cur.parts.push(pre)
      cur.line_fee = money(fm[1])
      close()
      continue
    }
    // Before any description text, a short spaceless fragment continues a wrapped item
    // number (the "CAN212-" / "CD*R49892" / "0" case); otherwise it's description.
    const continuesItem = cur.parts.length === 0
      && !s.includes(' ')
      && (/[-*]$/.test(cur.item_number) || s.length <= 2)
    if (continuesItem) cur.item_number += s
    else cur.parts.push(s)
  }
  close()

  const sum = items.reduce((a, i) => a + i.line_fee, 0)
  return {
    ...empty,
    items,
    totalFee,
    ok: totalFee !== null && items.length > 0 && Math.abs(sum - totalFee) < 0.005,
  }
}
