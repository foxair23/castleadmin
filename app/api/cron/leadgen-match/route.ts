import { NextRequest, NextResponse } from 'next/server'
import { matchConversions } from '@/lib/leadgen/engine'
import { ensureLeadCustomers } from '@/lib/leadgen/sf-customer'

export const maxDuration = 120

// Periodically: (1) check open leads against the SF job mirror and mark any that
// now have a matching job as booked; (2) pre-create an SF customer (no job) for
// leads that have aged onto the SFI Leads list, so CS has a record to build from.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const result = await matchConversions()
  const customers = await ensureLeadCustomers()
  return NextResponse.json({ ok: true, ...result, customers })
}
