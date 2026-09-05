import { NextRequest, NextResponse } from 'next/server'
import { parsePendingIpoAttachments } from '@/lib/vendor-orders/ipo-ingest'
import { syncPendingSfJobLines } from '@/lib/vendor-orders/sf-job-lines'

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

  // `candidates` vs `skipped` matters: "nothing to do" and "nothing recognized" are very
  // different outcomes and used to be indistinguishable here.
  return NextResponse.json({ ...total, remaining, batches, sf_lines: sfLines, elapsed_ms: Date.now() - started, ok_run: true, done: remaining === 0 })
}
