import { describe, it, expect } from 'vitest'
import { guessAsk } from '@/lib/agent/email/chat-assist'

// A team member who forgets to reply in Cassie's thread is usually answering the question
// she just asked. One open ask: that one. Several: the newest, only if it was posted or
// answered in the last two hours. Otherwise she asks which.
describe('guessAsk', () => {
  const now = Date.parse('2026-09-14T17:00:00Z')
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString()
  it('picks the only open ask however old', () => {
    expect(guessAsk([{ id: 'a', posted_at: at(30 * 60) }], now)?.id).toBe('a')
  })
  it('picks the newest of several when she asked it just now', () => {
    expect(guessAsk([{ id: 'old', posted_at: at(300) }, { id: 'new', posted_at: at(20) }], now)?.id).toBe('new')
  })
  it('counts a recent answer as recent activity on an older ask', () => {
    expect(guessAsk([{ id: 'a', posted_at: at(600), responded_at: at(5) }, { id: 'b', posted_at: at(400) }], now)?.id).toBe('a')
  })
  it('does not guess when several are open and none is recent', () => {
    expect(guessAsk([{ id: 'a', posted_at: at(300) }, { id: 'b', posted_at: at(400) }], now)).toBeNull()
  })
  it('nothing open, nothing guessed', () => { expect(guessAsk([], now)).toBeNull() })
})
