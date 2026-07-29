import { NextRequest, NextResponse } from 'next/server'
import { isPtHour } from '@/lib/cron/pt-gate'
import { todayPT } from '@/lib/action-items/config'
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

  // Never send on weekends. A stage that comes due Sat/Sun isn't lost — the
  // engine only sends the most-advanced *unsent* stage, so it simply goes out
  // on Monday's run instead.
  const [y, m, d] = todayPT().split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sun, 6 = Sat
  if (dow === 0 || dow === 6) {
    return NextResponse.json({ ok: true, skipped: 'weekend' })
  }

  const result = await runReminders()
  return NextResponse.json({ ok: true, ...result })
}
