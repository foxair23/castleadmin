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
  // Isolate the two passes: a failure in conversion-matching must never block SF
  // customer pre-creation (they're independent), and vice-versa.
  const result: Record<string, unknown> = {}
  try {
    Object.assign(result, await matchConversions())
  } catch (e) {
    console.error('[leadgen-match] matchConversions failed:', e instanceof Error ? e.message : e)
    result.matchError = e instanceof Error ? e.message : String(e)
  }
  const customers: Record<string, unknown> = {}
  try {
    Object.assign(customers, await ensureLeadCustomers())
  } catch (e) {
    console.error('[leadgen-match] ensureLeadCustomers failed:', e instanceof Error ? e.message : e)
    customers.customerError = e instanceof Error ? e.message : String(e)
  }
  return NextResponse.json({ ok: true, ...result, customers })
}
