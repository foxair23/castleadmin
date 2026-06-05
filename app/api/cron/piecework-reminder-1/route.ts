import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { enqueueNotification } from '@/lib/notifications/enqueue'
import { renderPieceworkReminder } from '@/lib/notifications/templates/piecework-reminder'
import { getWeekStart, getWeekEnd, formatDate } from '@/lib/week'

// Runs Wed 16:00 UTC = Wed 8–9 AM PT (morning reminder on deadline day)
export const maxDuration = 60

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const enqueued = await enqueuePieceworkReminders()
  return NextResponse.json({ ok: true, enqueued })
}

export async function enqueuePieceworkReminders(): Promise<number> {
  const supabase = db()

  // The week with a deadline today (Wednesday): started 9 days ago (the previous Monday)
  const now = new Date()
  const currentWeekStart = getWeekStart(now)
  const d = new Date(currentWeekStart)
  d.setDate(d.getDate() - 7)
  const targetWeekStart = formatDate(d)
  const targetWeekEnd = getWeekEnd(targetWeekStart)

  // Find all active technicians
  const { data: techs } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'technician')
    .eq('is_active', true)

  if (!techs || techs.length === 0) return 0

  // Find which techs have already submitted
  const { data: submissions } = await supabase
    .from('week_submissions')
    .select('tech_id')
    .eq('week_start_date', targetWeekStart)

  const submittedIds = new Set((submissions ?? []).map(s => s.tech_id as string))

  // Enqueue for those who haven't submitted and have the preference enabled
  const { data: prefs } = await supabase
    .from('user_notification_preferences')
    .select('user_id, notification_types!inner(key)')
    .eq('notification_types.key', 'piecework_reminder')
    .eq('is_enabled', true)
    .in('user_id', techs.map(t => t.id))

  const enabledIds = new Set((prefs ?? []).map(p => p.user_id as string))

  // Format the deadline for the email
  const deadlineDate = 'Wednesday at 11:59 PM'
  const weekLabel = `${formatMonthDay(targetWeekStart)} – ${formatMonthDay(targetWeekEnd)}`

  let count = 0
  for (const tech of techs) {
    if (submittedIds.has(tech.id)) continue
    if (!enabledIds.has(tech.id)) continue

    const { subject, bodyHtml, bodyText } = renderPieceworkReminder({
      fullName: (tech.full_name as string).split(' ')[0],
      weekLabel,
      deadlineDate,
      submitUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'}/tech`,
    })

    await enqueueNotification({
      notificationTypeKey: 'piecework_reminder',
      userId: tech.id,
      subject,
      bodyHtml,
      bodyText,
      relatedEntityType: 'week_submission',
      relatedEntityId: targetWeekStart,
    })
    count++
  }

  return count
}

function formatMonthDay(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[m - 1]} ${d}`
}
