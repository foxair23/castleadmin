import { NextRequest, NextResponse } from 'next/server'
import { matchConversions } from '@/lib/leadgen/engine'

export const maxDuration = 120

// Periodically check open leads against the SF job mirror and mark any that now
// have a matching job (created after the lead) as booked.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const result = await matchConversions()
  return NextResponse.json({ ok: true, ...result })
}
