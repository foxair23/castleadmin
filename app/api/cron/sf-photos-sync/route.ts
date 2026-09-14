import { NextRequest, NextResponse } from 'next/server'
import { agentDb } from '@/lib/agent/settings'
import { syncRecentJobPhotos } from '@/lib/reputation/photo-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Hourly in office hours: for finished jobs (allowed categories, last two days) with no
// stored photos, download their pictures straight from Service Fusion's picture bucket,
// so the 6am post pass finds them ready.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const r = await syncRecentJobPhotos(agentDb(), { deadline: Date.now() + 100_000 })
  return NextResponse.json({ ok: true, ...r })
}
