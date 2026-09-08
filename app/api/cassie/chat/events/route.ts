import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { verifyEventToken, allowedIssuers, allowedAudiences } from '@/lib/agent/chat/google-chat'
import { agentDb, loadAgentSettings } from '@/lib/agent/settings'
import { handleChatMessage, handleCardClick, normalizeChatEvent, type ChatEvent } from '@/lib/agent/email/chat-assist'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Google Chat → Castle Admin. Google requires a response within 30 seconds; composing a
// reply can take longer. So: verify, acknowledge immediately (for a button, with a
// "Working…" card update), and do the real work after the response (PRD §11).
export async function POST(req: NextRequest) {
  const v = await verifyEventToken(req.headers.get('authorization'))
  if (!v.ok) {
    // Google shows the user "Cassie not responding" for any non-2xx, with no hint as to
    // why. Log the reason so the cause is one look at the Vercel logs rather than a guess.
    console.error(`[cassie chat] rejected an event: ${v.reason}. Accepted issuers: ${allowedIssuers().join(', ')} · accepted audiences: ${allowedAudiences().join(', ')}`)
    return NextResponse.json({ error: `unauthorized: ${v.reason}` }, { status: 401 })
  }

  let ev: ChatEvent
  try { ev = normalizeChatEvent(await req.json() as Record<string, unknown>) }
  catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const db = agentDb()

  if (ev.type === 'ADDED_TO_SPACE') {
    // The add-on envelope wants a different response shape for a synchronous message, and
    // a greeting is not worth a second format to get wrong. Stay quiet there.
    if (ev.addon) return NextResponse.json({})
    return NextResponse.json({ text: "Hi, I'm Cassie. When I can't answer a partner email from our records I'll ask here. Reply in the thread (mention @Cassie) and I'll write the partner reply for you to approve." })
  }
  if (ev.type === 'MESSAGE') {
    after(async () => {
      try { const settings = await loadAgentSettings(db); const r = await handleChatMessage(db, settings, ev); console.log('[cassie chat] message:', r) }
      catch (e) { console.error('[cassie chat] message failed:', e instanceof Error ? e.message : e) }
    })
    return NextResponse.json({})   // silent ack; the card/thread reply comes asynchronously
  }
  if (ev.type === 'CARD_CLICKED') {
    after(async () => {
      try { const settings = await loadAgentSettings(db); const r = await handleCardClick(db, settings, ev); console.log('[cassie chat] click:', r) }
      catch (e) { console.error('[cassie chat] click failed:', e instanceof Error ? e.message : e) }
    })
    // Immediate feedback on the card so the tap never looks broken — classic envelope
    // only; the add-on form uses a different action shape, and the work still lands.
    if (ev.addon) return NextResponse.json({})
    return NextResponse.json({ actionResponse: { type: 'UPDATE_MESSAGE' }, text: 'Working on it…' })
  }
  // Anything we do not recognise is logged with its shape. Returning 200 and saying
  // nothing is what made the add-on envelope invisible for a day.
  console.warn(`[cassie chat] unhandled event type: ${ev.type}`)
  return NextResponse.json({})
}
