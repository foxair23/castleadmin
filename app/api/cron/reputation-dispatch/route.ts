import { NextRequest, NextResponse } from 'next/server'
import { agentDb } from '@/lib/agent/settings'
import { runDispatch } from '@/lib/reputation/dispatcher'
import { DISPATCH_HANDLERS } from '@/lib/reputation/handlers'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// Every minute: send whatever the reputation engine has scheduled for now
// (review replies, CSAT reminders, later profile posts). Cheap no-op when
// nothing is due or sends are paused.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const report = await runDispatch(agentDb(), DISPATCH_HANDLERS)
  return NextResponse.json({ ok: true, ...report })
}
