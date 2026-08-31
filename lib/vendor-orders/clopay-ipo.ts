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

/** Parse the text of an IPO PDF into structured line items + the document total. */
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
