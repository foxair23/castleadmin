import { NextRequest, NextResponse } from 'next/server'
import { runEsignCustomerSweep } from '@/lib/esign/send'

export const maxDuration = 120

// Hourly during business hours PT: send whichever e-sign message is due to each customer
// (heads-up the morning of the work, the ask the day after, one reminder three days on).
// Does nothing while the e-sign setting is OFF.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const r = await runEsignCustomerSweep()
  return NextResponse.json({ ...r, ok_run: true })
}
