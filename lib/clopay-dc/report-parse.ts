// Parser for the weekly Clopay DC report ("Fully Received and Reserved") — the Monday email
// listing what is physically sitting at the San Diego DC waiting to be picked up.
//
// Deterministic and shape-driven, in the same spirit as lib/vendor-orders/clopay-ipo.ts: a
// data line is recognised by the facts it must carry (a 9-digit Clopay order number and two
// DD-MON-YYYY dates), never by column offsets, which a PDF text extractor does not preserve.
//
// The ingest stores the extracted text alongside the parse, so a parser improvement can be
// re-run against past reports without needing the original emails again.

export interface DcReportRow {
  orderNo: string
  po: string | null
  /** 'HD' = Home Depot program order (Clopay customer 000032); 'CASTLE_DIRECT' = Castle's own
   *  order (customer 61232), which appears in no other system we have. */
  kind: 'HD' | 'CASTLE_DIRECT'
  enteredDate: string | null   // ISO
  reservedDate: string | null  // ISO
}

export interface DcReportParseResult {
  rows: DcReportRow[]
  reportDate: string | null
  /** Rows parsed with no obviously broken field. False asks a human to look at the PDF. */
  ok: boolean
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
}

/** '22-JAN-2026' → '2026-01-22'. The report's only date format. */
export function toIsoDate(s: string | null | undefined): string | null {
  const m = (s ?? '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/)
  if (!m) return null
  const mm = MONTHS[m[2].toUpperCase()]
  if (!mm) return null
  return `${m[3]}-${mm}-${String(m[1]).padStart(2, '0')}`
}

const DATE = String.raw`\d{1,2}-[A-Za-z]{3}-\d{4}`
// Order number, an optional PO token, then the two dates. The PO is optional because
// Castle-direct orders carry none, and it is NOT \d+ because real POs include forms like
// RPP88431947 and RP48478131.
const ROW_RE = new RegExp(String.raw`\b(\d{9})\b\s+(?:([A-Za-z0-9][A-Za-z0-9\-/]*)\s+)?(${DATE})\s+(${DATE})`)
const CASTLE_CUSTOMER = /\b61232\b/
const HD_CUSTOMER = /\b0*32\b|\bHOME\s*DEPOT\b/i

/** Parse one report's extracted text. */
export function parseDcReport(text: string): DcReportParseResult {
  const lines = (text ?? '').split(/\r?\n/)
  const rows: DcReportRow[] = []
  const seen = new Set<string>()
  // The report is grouped by Clopay customer; the group header decides what each row under
  // it is. Rows carry no customer of their own, so this context has to be tracked.
  let kind: 'HD' | 'CASTLE_DIRECT' | null = null
  let reportDate: string | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (!reportDate) {
      const d = line.match(new RegExp(String.raw`(?:RUN|REPORT|AS\s+OF|DATE)[^\d]{0,12}(${DATE})`, 'i'))
      if (d) reportDate = toIsoDate(d[1])
    }
    if (CASTLE_CUSTOMER.test(line)) kind = 'CASTLE_DIRECT'
    else if (HD_CUSTOMER.test(line)) kind = 'HD'

    const m = line.match(ROW_RE)
    if (!m) continue
    const [, orderNo, poRaw, d1, d2] = m
    if (seen.has(orderNo)) continue

    let entered = toIsoDate(d1)
    let reserved = toIsoDate(d2)
    // Product cannot be reserved before it was entered; if the columns come out of the
    // extractor the other way round, trust the chronology rather than the position.
    if (entered && reserved && reserved < entered) [entered, reserved] = [reserved, entered]

    const po = poRaw && !new RegExp(`^${DATE}$`).test(poRaw) ? poRaw : null
    seen.add(orderNo)
    rows.push({
      orderNo,
      po,
      // A missing PO is itself the Castle-direct signal — those orders have no HD PO — so it
      // stands in when no group header was recognised.
      kind: kind ?? (po ? 'HD' : 'CASTLE_DIRECT'),
      enteredDate: entered,
      reservedDate: reserved,
    })
  }

  const ok = rows.length > 0 && rows.every(r => r.reservedDate !== null)
  return { rows, reportDate, ok }
}
