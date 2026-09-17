import { NextRequest, NextResponse } from 'next/server'
import { runEsignCustomerSweep } from '@/lib/esign/send'
import { runEsignTechSweep } from '@/lib/esign/tech'
import { runEsignFinalizeSweep } from '@/lib/esign/finalize'

export const maxDuration = 120

// Every 15 minutes during business hours PT: send whichever e-sign message is due to each
// customer (heads-up the morning of the work, the ask once it is done, one reminder three
// days on). The customer pass does nothing while the e-sign setting is OFF; the tech and
// finalize passes follow signatures that already happened (manual sends included).
//
// On the hour the customer pass is complete. In between it runs in `quick` mode — only
// documents nothing has been sent for yet — because each candidate costs one live Service
// Fusion read, and the only thing that needs minute-level freshness is the office setting
// "HD SOF Needed" on a job that is being worked today. The tech and finalize passes touch
// no external service at all, so they run every time and a technician now gets their link
// within minutes of the customer signing instead of within the hour.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Minute, not a query string: one cron entry, and a missed :00 firing cannot turn an
  // hourly pass into a permanently quick one.
  const quick = new Date().getMinutes() >= 10
  const customer = await runEsignCustomerSweep(new Date(), { quick })
  // Independent of the setting: these documents were already sent, by the sweep or by hand.
  const tech = await runEsignTechSweep()
  const finalize = await runEsignFinalizeSweep()
  return NextResponse.json({ quick, customer, tech, finalize, ok_run: true })
}
