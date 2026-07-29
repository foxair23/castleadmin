import { NextRequest, NextResponse } from 'next/server'
import { isPtHour } from '@/lib/cron/pt-gate'
import { loadSettings, runReminders } from '@/lib/invoice-reminders/engine'

export const maxDuration = 300

// Invoice reminder run (daily). Master switch defaults OFF, so this no-ops until
// enabled in admin. Pinned to the configured send hour PT — scheduled at both
// candidate UTC hours (14:00/15:00 for the 9am default) and gated so it runs
// once at the intended PT hour across DST.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const settings = await loadSettings()
  if (!settings.enabled) return NextResponse.json({ ok: true, skipped: 'disabled' })
  if (!isPtHour(settings.send_hour_pt)) {
    return NextResponse.json({ ok: true, skipped: `off-hour (send hour is ${settings.send_hour_pt} PT)` })
  }

  const result = await runReminders()
  return NextResponse.json({ ok: true, ...result })
}
