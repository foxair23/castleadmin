import { NextRequest, NextResponse } from 'next/server'
import { parsePendingIpoAttachments } from '@/lib/vendor-orders/ipo-ingest'
import { syncPendingSfJobLines } from '@/lib/vendor-orders/sf-job-lines'
import { classifyPendingAttachments } from '@/lib/esign/backfill'

export const maxDuration = 300

// Parses stored Clopay IPO PDFs into structured line items. New documents are parsed by the
// store route as they arrive; this sweep backfills the ones captured before that existed (and
// retries nothing — a document is stamped parsed_at either way, so runs are idempotent).
//
// It loops until the backlog is empty or the time budget is spent: at one 25-doc batch per
// night a several-hundred-document backlog would take weeks to drain. `?limit=` caps a single
// batch (handy for a manual probe); the loop is what finishes the job.
const BUDGET_MS = 240_000

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 25) || 25, 100)
  const once = req.nextUrl.searchParams.get('once') === '1'
  const started = Date.now()

  const total = { candidates: 0, skipped: 0, processed: 0, ok: 0, mismatch: 0, error: 0, recovered: 0 }
  let remaining = 0
  let batches = 0
  for (;;) {
    const c = await parsePendingIpoAttachments(limit)
    batches++
    total.candidates += c.candidates
    total.skipped += c.skipped
    total.processed += c.processed
    total.ok += c.ok
    total.mismatch += c.mismatch
    total.error += c.error
    total.recovered += c.recovered
    remaining = c.remaining
    // Nothing left to look at, or a batch that moved nothing (don't spin).
    if (once || remaining === 0 || (c.processed === 0 && c.skipped === 0)) break
    if (Date.now() - started > BUDGET_MS) break
  }

  // Now that parsing is done, push the new lines onto jobs that already exist. The IPO almost
  // always arrives AFTER the job was created — the order is crawled and autopilot books the
  // job within 15 minutes, while the document is only captured on the next extension doc sync
  // — so attaching at creation alone would leave most jobs empty. Only jobs carrying no
  // services are written to; anything with hand-entered lines is reported, never overwritten.
  const sfLines = await syncPendingSfJobLines(50)

  // Classify stored documents for e-sign (blank lien waivers → esign rows; signed ones close
  // them). Backfills the ones captured before the crawl carried the document type; new
  // documents are classified by the store route as they arrive. Same time budget.
  const esign = { looked: 0, lien_waiver: 0, signed: 0, none: 0, remaining: 0, batches: 0 }
  for (;;) {
    const c = await classifyPendingAttachments(100)
    esign.batches++; esign.looked += c.looked; esign.lien_waiver += c.lien_waiver; esign.signed += c.signed; esign.none += c.none; esign.remaining = c.remaining
    if (once || c.remaining === 0 || c.looked === 0 || Date.now() - started > BUDGET_MS) break
  }

  // `candidates` vs `skipped` matters: "nothing to do" and "nothing recognized" are very
  // different outcomes and used to be indistinguishable here.
  return NextResponse.json({ ...total, remaining, batches, sf_lines: sfLines, esign, elapsed_ms: Date.now() - started, ok_run: true, done: remaining === 0 })
}
