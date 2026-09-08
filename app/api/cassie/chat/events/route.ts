import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { verifyEventToken, allowedIssuers, allowedAudiences } from '@/lib/agent/chat/google-chat'
import { agentDb, loadAgentSettings } from '@/lib/agent/settings'
import { handleChatMessage, handleCardClick, type ChatEvent } from '@/lib/agent/email/chat-assist'

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
  try { ev = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const db = agentDb()

  if (ev.type === 'ADDED_TO_SPACE') {
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
    // Immediate feedback on the card so the tap never looks broken.
    return NextResponse.json({ actionResponse: { type: 'UPDATE_MESSAGE' }, text: 'Working on it…' })
  }
  return NextResponse.json({})
}
