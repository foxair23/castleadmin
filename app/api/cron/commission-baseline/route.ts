import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isPtHour } from '@/lib/cron/pt-gate'
import { todayPT } from '@/lib/action-items/config'

export const maxDuration = 60

// Commission upsell baseline capture (daily, 7am PT).
//
// Snapshots each job's current total on the MORNING of its service day, before
// the tech goes out — this is the "before" figure the Upsell tab compares
// against the final commission revenue. Captured once per job and never
// overwritten (the SF sync would otherwise move the total as work is upsold).
//
// Scheduled at both 14:00 and 15:00 UTC; the PT gate runs it only on the 7 AM
// PT firing so it stays pinned to 7 AM across the PDT/PST switch.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isPtHour(7)) {
    return NextResponse.json({ ok: true, skipped: 'off-hour (pinned to 7 AM PT)' })
  }

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const today = todayPT()

  // Every non-deleted job whose service day is today. Snapshot ALL of them, not
  // just commission candidates — a job's commission claim often lands after the
  // service day, and we'd otherwise have no baseline for it.
  const rows: Array<{ sf_job_id: string; baseline_total: number; captured_at: string }> = []
  const now = new Date().toISOString()
  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data: page, error } = await db
      .from('sf_jobs')
      .select('id, total')
      .eq('start_date', today)
      .eq('is_deleted', false)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    if (!page || page.length === 0) break
    for (const j of page as Array<{ id: string; total: number | null }>) {
      rows.push({ sf_job_id: j.id, baseline_total: j.total ?? 0, captured_at: now })
    }
    if (page.length < PAGE) break
    from += PAGE
  }

  let inserted = 0
  if (rows.length > 0) {
    // ignoreDuplicates: never overwrite a baseline already captured for a job.
    const { data, error } = await db
      .from('commission_job_baseline')
      .upsert(rows, { onConflict: 'sf_job_id', ignoreDuplicates: true })
      .select('sf_job_id')
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    inserted = data?.length ?? 0
  }

  return NextResponse.json({ ok: true, date: today, scanned: rows.length, captured: inserted })
}
