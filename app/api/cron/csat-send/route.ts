import { NextRequest, NextResponse } from 'next/server'
import { currentPtHour } from '@/lib/cron/pt-gate'
import { loadCsatSettings } from '@/lib/csat/config'
import { runCsatSurveys } from '@/lib/csat/engine'

export const maxDuration = 300

// Post-job CSAT survey run. Master switch defaults OFF, so this no-ops until
// enabled in admin (Reviews → CSAT). Scheduled every 15 min during the UTC hours
// that cover the PT texting window; the handler gates on the configured PT window
// so surveys only text customers between send_start_hour_pt and send_end_hour_pt.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const settings = await loadCsatSettings()
  if (!settings.enabled) return NextResponse.json({ ok: true, skipped: 'disabled' })

  const hour = currentPtHour()
  if (hour < settings.send_start_hour_pt || hour >= settings.send_end_hour_pt) {
    return NextResponse.json({ ok: true, skipped: `outside texting window (${hour} PT)` })
  }

  const result = await runCsatSurveys()
  return NextResponse.json({ ok: true, ...result })
}
