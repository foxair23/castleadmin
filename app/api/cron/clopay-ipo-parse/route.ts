import { NextRequest, NextResponse } from 'next/server'
import { parsePendingIpoAttachments } from '@/lib/vendor-orders/ipo-ingest'

export const maxDuration = 300

// Parses stored Clopay IPO PDFs into structured line items. New documents are parsed by the
// store route as they arrive; this sweep backfills the ones captured before that existed (and
// retries nothing — a document is stamped parsed_at either way, so runs are idempotent).
// Batched so a run stays well inside the function timeout; repeated runs drain the backlog.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 25) || 25, 100)
  const counts = await parsePendingIpoAttachments(limit)
  return NextResponse.json({ ...counts, ok: true, done: counts.processed === 0 })
}
