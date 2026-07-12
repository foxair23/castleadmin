import { NextRequest, NextResponse } from 'next/server'
import { enqueueForSubscribers } from '@/lib/notifications/enqueue'
import { adminDb, computeTodoDigest, dateLabelPT, renderTodoEmail } from '@/lib/action-items/digest'

export const maxDuration = 300

// Afternoon check-in (Mon–Sat 3pm PT): scoreboard of what the team actioned
// today vs. what still needs a touch before end of day. Same classification as
// the morning digest — anything actioned today has already dropped out of the
// remaining buckets, so the lists below the scoreboard are exactly what's left.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const started = Date.now()

  const d = await computeTodoDigest(adminDb())
  const remaining = d.totalNew + d.totalDue

  // Quiet day (nothing actioned, nothing pending) → no email.
  if (remaining === 0 && d.actionedToday === 0) {
    return NextResponse.json({ ok: true, skipped: 'nothing to report', ms: Date.now() - started })
  }

  const dateLabel = dateLabelPT()
  const subject = `Action Items 3 PM check-in — ${d.actionedToday} actioned today · ${remaining} still need action`

  const breakdown = [...d.actionedTodayByLabel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${label} ×${n}`)
    .join(' · ')

  const introHtml = `
  <div style="display:flex;gap:12px;margin:10px 0 4px;">
    <div style="flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;">
      <p style="font-size:22px;font-weight:700;color:#15803d;margin:0;">✅ ${d.actionedToday}</p>
      <p style="font-size:12px;color:#166534;margin:2px 0 0;">actioned today${breakdown ? ` — ${breakdown}` : ''}</p>
    </div>
    <div style="flex:1;background:${remaining > 0 ? '#fef2f2' : '#f0fdf4'};border:1px solid ${remaining > 0 ? '#fecaca' : '#bbf7d0'};border-radius:8px;padding:10px 14px;">
      <p style="font-size:22px;font-weight:700;color:${remaining > 0 ? '#b91c1c' : '#15803d'};margin:0;">${remaining > 0 ? '🔴' : '🎉'} ${remaining}</p>
      <p style="font-size:12px;color:${remaining > 0 ? '#991b1b' : '#166534'};margin:2px 0 0;">${remaining > 0 ? 'still need action before end of day' : 'nothing left — all clear'}</p>
    </div>
  </div>`

  const { html, text } = renderTodoEmail(d, {
    heading: '3 PM Check-In — Action Items',
    subtitle: `${dateLabel} · ✅ ${d.actionedToday} actioned today · ${remaining > 0 ? `🔴 ${remaining} still open` : '🎉 all clear'}`,
    introHtml,
    introText: `Actioned today: ${d.actionedToday}${breakdown ? ` (${breakdown})` : ''} · Still needing action: ${remaining}`,
  })

  const queued = await enqueueForSubscribers({
    notificationTypeKey: 'daily_action_items_todo',
    subject,
    bodyHtml: html,
    bodyText: text,
  })

  return NextResponse.json({ ok: true, actionedToday: d.actionedToday, remaining, queued, ms: Date.now() - started })
}
