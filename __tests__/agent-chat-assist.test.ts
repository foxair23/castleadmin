import { describe, it, expect } from 'vitest'
import { planForAsk, normalizeChatEvent } from '@/lib/agent/email/chat-assist'

// Silence is the worst answer in a chat thread: someone who writes to Cassie and gets
// nothing cannot tell whether she is broken, ignoring them, or slow. Every status either
// acts or explains itself.
describe('planForAsk', () => {
  it('takes an answer while the question is still live', () => {
    for (const s of ['open', 'answered']) expect(planForAsk(s, false)).toEqual({ act: 'answer' })
  })

  it('still takes a late answer after the timeout escalated it', () => {
    // The timeout escalates the email to our own team; nothing has gone to the partner,
    // so the answer is still worth having.
    expect(planForAsk('timed_out', false)).toEqual({ act: 'answer' })
  })

  it('treats a message as the edited text when an edit was requested', () => {
    expect(planForAsk('composed', true)).toEqual({ act: 'edit' })
    expect(planForAsk('sent', true)).toEqual({ act: 'edit' })
  })

  it('explains itself instead of going quiet once the question is closed', () => {
    for (const s of ['composed', 'approved', 'sent', 'reviewed', 'something_new']) {
      const p = planForAsk(s, false)
      expect(p.act).toBe('explain')
      expect((p as { text: string }).text.length).toBeGreaterThan(20)
    }
  })

  it('never claims to have changed anything it did not', () => {
    for (const s of ['approved', 'sent']) {
      expect((planForAsk(s, false) as { text: string }).text).toMatch(/not changed anything/)
    }
  })
})

// A Chat app built as a Workspace add-on sends a different envelope, with no `type` field.
// A handler that switches on `type` then does nothing and answers 200 — no error in Chat,
// no reply, nothing in our logs, which is exactly how this sat.
describe('normalizeChatEvent', () => {
  const addonMessage = {
    chat: {
      user: { displayName: 'John', email: 'j@castlegarage.com' },
      messagePayload: {
        space: { name: 'spaces/AAA' },
        message: {
          name: 'spaces/AAA/messages/1',
          argumentText: ' we do not know ',
          thread: { name: 'spaces/AAA/threads/T1' },
          sender: { displayName: 'John' },
        },
      },
    },
    commonEventObject: { parameters: {} },
  }

  it('reads an add-on message as a MESSAGE, keeping space, thread, sender and text', () => {
    const ev = normalizeChatEvent(addonMessage)
    expect(ev.type).toBe('MESSAGE')
    expect(ev.addon).toBe(true)
    expect(ev.space?.name).toBe('spaces/AAA')
    expect(ev.message?.thread?.name).toBe('spaces/AAA/threads/T1')
    expect(ev.message?.argumentText).toBe(' we do not know ')
    expect(ev.user?.email).toBe('j@castlegarage.com')
  })

  it('reads an add-on button click, with its parameters', () => {
    const ev = normalizeChatEvent({
      chat: { user: { displayName: 'John' }, buttonClickedPayload: { space: { name: 'spaces/AAA' }, message: { name: 'spaces/AAA/messages/2' } } },
      commonEventObject: { invokedFunction: 'approve', parameters: { ask: 'a1', reply: 'r1' } },
    })
    expect(ev.type).toBe('CARD_CLICKED')
    expect(ev.common?.invokedFunction).toBe('approve')
    expect(ev.common?.parameters).toEqual({ ask: 'a1', reply: 'r1' })
  })

  it('reads an add-on join event', () => {
    expect(normalizeChatEvent({ chat: { addedToSpacePayload: { space: { name: 'spaces/AAA' } } } }).type).toBe('ADDED_TO_SPACE')
  })

  it('passes a classic event through untouched, and does not mark it as an add-on', () => {
    const classic = { type: 'MESSAGE', space: { name: 'spaces/B' }, message: { text: 'hi', thread: { name: 'spaces/B/threads/T' } }, user: { displayName: 'Jane' } }
    const ev = normalizeChatEvent(classic)
    expect(ev).toEqual(classic)
    expect(ev.addon).toBeUndefined()
  })

  it('names an envelope it does not recognise instead of swallowing it', () => {
    expect(normalizeChatEvent({ chat: { somethingNewPayload: {} } }).type).toMatch(/unknown chat payload: somethingNewPayload/)
  })
})
