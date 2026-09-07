import { NextRequest, NextResponse } from 'next/server'
import { agentDb } from '@/lib/agent/settings'
import { runPoll } from '@/lib/agent/email/poll'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// Every minute: fetch Cassie's new mail, run the pipeline, send queued replies.
// No-op (cheap) while the Processing switch is off or no mailbox is connected.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const report = await runPoll(agentDb())
  return NextResponse.json(report)
}
