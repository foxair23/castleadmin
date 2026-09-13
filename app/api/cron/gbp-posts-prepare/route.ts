import { NextRequest, NextResponse } from 'next/server'
import { agentDb } from '@/lib/agent/settings'
import { isPtHour } from '@/lib/cron/pt-gate'
import { runPostPreparation } from '@/lib/reputation/post-drafter'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

// Every morning at 6 PT (scheduled at both candidate UTC hours; the gate picks
// the right one): pull yesterday's finished jobs, import and score their photos,
// and draft a profile post for the best of them. The drafts wait for a person
// unless the posts autopilot switch is on; publishing goes through the
// reputation dispatcher at a humanized time inside working hours.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isPtHour(6) && req.nextUrl.searchParams.get('force') !== '1') {
    return NextResponse.json({ ok: true, skipped: 'not 6am PT' })
  }
  const report = await runPostPreparation(agentDb(), { deadline: Date.now() + 240_000 })
  return NextResponse.json({ ok: true, ...report })
}
