import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { enqueueForSubscribers, enqueueNotification } from '@/lib/notifications/enqueue'
import { renderSchedulerLeadStuck } from '@/lib/notifications/templates/scheduler-lead-stuck'

export const maxDuration = 60

// Minutes a partial booking can sit incomplete before staff are alerted.
const GRACE_MINUTES = 15

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

// Sends the "Partial Lead" alert for bookings still incomplete after the grace
// window. Each lead is alerted at most once (partial_notified_at marker).
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = db()
  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60_000).toISOString()

  const { data: leads } = await supabase
    .from('scheduler_leads')
    .select('id, customer_first_name, customer_phone')
    .eq('is_partial', true)
    .is('partial_notified_at', null)
    .lt('created_at', cutoff)
    .limit(200)

  const list = leads ?? []
  if (list.length === 0) return NextResponse.json({ ok: true, notified: 0 })

  const adminUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'}/admin/scheduler`

  // Sales users get notified unconditionally; cache the list.
  const { data: salesUsers } = await supabase
    .from('profiles').select('id').eq('role', 'sales').eq('is_active', true)

  let notified = 0
  for (const lead of list as Array<{ id: string; customer_first_name: string | null; customer_phone: string | null }>) {
    const { bodyHtml, bodyText } = renderSchedulerLeadStuck({
      customerName: lead.customer_first_name ?? 'Customer',
      phoneNumber: lead.customer_phone ?? '—',
      serviceLabel: 'Incomplete submission',
      appointmentDate: '—',
      reason: 'manual_push',
      adminUrl,
    })
    const subject = 'Action Item: Partial Lead'

    await enqueueForSubscribers({
      notificationTypeKey: 'scheduler_lead_stuck',
      subject, bodyHtml, bodyText,
      relatedEntityType: 'scheduler_lead', relatedEntityId: lead.id,
    }).catch(() => { /* non-critical */ })

    await Promise.all(
      (salesUsers ?? []).map((u: { id: string }) =>
        enqueueNotification({
          notificationTypeKey: 'scheduler_lead_stuck',
          userId: u.id,
          subject, bodyHtml, bodyText,
          relatedEntityType: 'scheduler_lead', relatedEntityId: lead.id,
        }).catch(() => { /* non-critical */ }),
      ),
    )

    await supabase.from('scheduler_leads').update({ partial_notified_at: new Date().toISOString() }).eq('id', lead.id)
    notified++
  }

  return NextResponse.json({ ok: true, notified })
}
