import { describe, it, expect } from 'vitest'
import { planForAsk } from '@/lib/agent/email/chat-assist'

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
