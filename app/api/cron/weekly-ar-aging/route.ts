import { NextRequest, NextResponse } from 'next/server'
import { sendArAgingReports } from '@/lib/ar-aging/send'
import { isPtHour } from '@/lib/cron/pt-gate'

export const maxDuration = 120

// Weekly Accounts Receivable Aging Report — Monday 7 AM PT.
// Scheduled at both 14:00 and 15:00 UTC Monday; the PT gate runs it only on the
// 7 AM PT firing so it stays pinned to 7 AM across the PDT/PST switch. Sends
// three emails (Clopay, Genie, Remainder) to every subscriber of the
// 'weekly_ar_aging' notification type. The manual "Email A/R Report" button in
// Action Items calls the same sendArAgingReports() for identical emails.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isPtHour(7)) {
    return NextResponse.json({ ok: true, skipped: 'off-hour (pinned to 7 AM PT Monday)' })
  }
  const started = Date.now()
  const result = await sendArAgingReports()
  return NextResponse.json({ ok: true, ...result, ms: Date.now() - started })
}
