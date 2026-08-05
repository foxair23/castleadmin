/**
 * Guard behavior for the AI residual matcher. The live model call isn't unit-
 * tested; these lock in the dormant-when-unconfigured and no-candidates contracts
 * so the AI path can never fire (or cost anything) unexpectedly.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { isAiMatchConfigured, aiSuggestMatch } from '@/lib/remittance/ai-match'

const line = { po: null, customer_name: 'PEARSON TUYETLE', vendor_ref: null, amount: 412, doc_date: null }

describe('AI matcher guards', () => {
  const prev = process.env.ANTHROPIC_API_KEY
  afterEach(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev })

  it('is dormant without an API key', () => {
    delete process.env.ANTHROPIC_API_KEY
    expect(isAiMatchConfigured()).toBe(false)
  })
  it('returns null with no candidates (never calls the model)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(await aiSuggestMatch(line, [])).toBeNull()
  })
  it('returns null when unconfigured even with candidates', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const candidates = [{ id: 'j1', number: '1020258683', customer_name: 'Pearson, Tuyetle', po_number: '12425510/', open_amount: 412 }]
    expect(await aiSuggestMatch(line, candidates)).toBeNull()
  })
})
