import { NextRequest, NextResponse } from 'next/server'
import { runEsignCustomerSweep } from '@/lib/esign/send'
import { runEsignTechSweep } from '@/lib/esign/tech'
import { runEsignFinalizeSweep } from '@/lib/esign/finalize'

export const maxDuration = 120

// Hourly during business hours PT: send whichever e-sign message is due to each customer
// (heads-up the morning of the work, the ask the day after, one reminder three days on).
// The customer pass does nothing while the e-sign setting is OFF; the tech and finalize
// passes follow signatures that already happened (manual sends included).
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const customer = await runEsignCustomerSweep()
  // Independent of the setting: these documents were already sent, by the sweep or by hand.
  const tech = await runEsignTechSweep()
  const finalize = await runEsignFinalizeSweep()
  return NextResponse.json({ customer, tech, finalize, ok_run: true })
}
