import { NextRequest, NextResponse } from 'next/server'
import { sendClopayRateDigest } from '@/lib/vendor-orders/clopay-rate-digest'

export const maxDuration = 60

// Daily digest of Clopay IPO lines paid at something other than the agreed labor rate.
// Grouped by code, so a systematic gap is one line rather than an email per order.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(await sendClopayRateDigest())
}
