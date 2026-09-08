import { describe, it, expect } from 'vitest'
import { planForAsk, normalizeChatEvent, describeLookup } from '@/lib/agent/email/chat-assist'
import { chatAnswerPos, humanAnswerMeta } from '@/lib/agent/email/composer-stage'

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

  it('treats a message after the draft as a revised answer, not a status request', () => {
    // "Don't send that — look up the other PO first" must recompose, not be told the draft
    // is waiting on the card above.
    expect(planForAsk('composed', false)).toEqual({ act: 'answer' })
  })

  it('explains itself instead of going quiet once the question is closed', () => {
    for (const s of ['approved', 'sent', 'reviewed', 'something_new']) {
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

// The team's answer often contains the thing to look up. Those numbers go to the resolver;
// the card then says what the lookup found, so "no job under that PO" is a result.
describe('chatAnswerPos', () => {
  it('pulls reference numbers out of a team answer', () => {
    expect(chatAnswerPos('I think that number belongs to a different order — possibly PO 74491444')).toEqual(['74491444'])
    expect(chatAnswerPos('try 1020259181, that is the SF job')).toEqual(['1020259181'])
  })
  it('finds nothing in an instruction with no number in it', () => {
    expect(chatAnswerPos("don't send that. can you look up that new PO first?")).toEqual([])
    expect(chatAnswerPos(null)).toEqual([])
  })
})

describe('describeLookup', () => {
  it('reports a match by job number', () => {
    expect(describeLookup({ resolve_status: 'matched', sf_job_number: '1020259225', identifiers: { pos: ['74491444'] } })).toBe('Looked up PO 74491444 — matched Job 1020259225.')
  })
  it('reports no match across every number tried', () => {
    expect(describeLookup({ resolve_status: 'none', identifiers: { pos: ['74233491444', '74491444'] } })).toBe('Looked up PO 74233491444, PO 74491444 — no job found under any of them.')
    expect(describeLookup({ resolve_status: 'none', identifiers: { pos: ['74491444'] } })).toMatch(/no job found under it/)
  })
  it('says when it deliberately did not pick between candidates', () => {
    expect(describeLookup({ resolve_status: 'ambiguous', identifiers: { pos: ['74491444'] } })).toMatch(/did not pick one/)
  })
  it('says nothing when there was nothing to look up', () => {
    expect(describeLookup({ resolve_status: 'none', identifiers: { pos: [] } })).toBeNull()
    expect(describeLookup(null)).toBeNull()
  })
})

// A human answer reaches the composer from two doors — Google Chat, or the reviewer typing
// in the Review tab. Whichever door, it must block auto-send; and what it is called in the
// sources, the blocker and the supersede reason must agree.
describe('humanAnswerMeta', () => {
  it('records a Chat answer as chat-sourced', () => {
    expect(humanAnswerMeta({ askId: 'a1', text: 'x', responder: 'John' })).toEqual({
      source: 'chat_answer', label: 'Team answer · John', hardFail: 'chat_sourced', cancelReason: 'chat_answered',
    })
  })
  it("records a reviewer's instruction as reviewer-sourced", () => {
    expect(humanAnswerMeta({ text: 'x', responder: 'John', channel: 'review' })).toEqual({
      source: 'reviewer_note', label: 'Reviewer · John', hardFail: 'reviewer_sourced', cancelReason: 'revised_in_review',
    })
  })
  it('never lets a human-fed draft auto-send, from either door', () => {
    for (const channel of ['chat', 'review'] as const) {
      expect(humanAnswerMeta({ text: 'x', responder: 'J', channel }).hardFail).toMatch(/_sourced$/)
    }
  })
})
