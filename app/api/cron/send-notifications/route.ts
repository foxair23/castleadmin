import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/notifications/resend'

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

  const supabase = db()
  const now = new Date().toISOString()

  // Fetch a batch of queued notifications ready to send
  const { data: rows, error: fetchErr } = await supabase
    .from('notification_log')
    .select('id, user_id, subject, body_html, body_text, attempts')
    .in('status', ['queued', 'failed'])
    .lte('send_after', now)
    .lt('attempts', 3)
    .order('send_after', { ascending: true })
    .limit(50)

  if (fetchErr) {
    console.error('[send-notifications] fetch error:', fetchErr.message)
    return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 })
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 })
  }

  const ids = rows.map(r => r.id)

  // Optimistically claim the batch (only update rows still in queued/failed)
  await supabase
    .from('notification_log')
    .update({ status: 'sending' })
    .in('id', ids)
    .in('status', ['queued', 'failed'])

  // Build a map of user_id → email using the admin auth API
  const userIds = [...new Set(rows.map(r => r.user_id as string))]
  const emailMap = new Map<string, string>()

  await Promise.all(
    userIds.map(async uid => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid)
        if (data.user?.email) emailMap.set(uid, data.user.email)
      } catch { /* skip */ }
    })
  )

  let sent = 0
  let failed = 0

  await Promise.all(
    rows.map(async row => {
      const email = emailMap.get(row.user_id as string)
      if (!email) {
        await supabase
          .from('notification_log')
          .update({
            status: 'failed',
            attempts: (row.attempts as number) + 1,
            error_message: 'No email address found for user',
          })
          .eq('id', row.id)
        failed++
        return
      }

      try {
        await sendEmail({
          to: email,
          subject: row.subject as string,
          html: row.body_html as string,
          text: row.body_text as string,
        })
        await supabase
          .from('notification_log')
          .update({ status: 'sent', sent_at: new Date().toISOString(), attempts: (row.attempts as number) + 1 })
          .eq('id', row.id)
        sent++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[send-notifications] failed to send ${row.id}:`, msg)
        await supabase
          .from('notification_log')
          .update({
            status: 'failed',
            attempts: (row.attempts as number) + 1,
            error_message: msg.slice(0, 500),
          })
          .eq('id', row.id)
        failed++
      }
    })
  )

  return NextResponse.json({ ok: true, sent, failed })
}
