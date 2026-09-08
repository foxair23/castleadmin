import { describe, it, expect } from 'vitest'
import { groupCoverageLog, fingerprint, pickStyleExamples, editRateByType, type CoverageRow, type EditRateRow } from '@/lib/agent/email/learning'
import type { StyleExample } from '@/lib/agent/knowledge'

describe('coverage demand log', () => {
  it('fingerprint ignores numbers, stop words and order', () => {
    expect(fingerprint('Confirmed ship date for PO 1020259181 from Clopay')).toBe(fingerprint('ship date from clopay confirmed 55555555'))
  })
  it('clusters by type + wording, biggest first, with the latest wording and both dates', () => {
    const rows: CoverageRow[] = [
      { id: '1', message_id: 'm1', question_type: 'ship_date', missing: 'a confirmed ship date from Clopay for PO 1', created_at: '2026-09-01T00:00:00Z' },
      { id: '2', message_id: 'm2', question_type: 'ship_date', missing: 'Confirmed ship date from Clopay (PO 2)', created_at: '2026-09-03T00:00:00Z' },
      { id: '3', message_id: null, question_type: 'warranty', missing: 'warranty terms for openers', created_at: '2026-09-02T00:00:00Z' },
    ]
    const c = groupCoverageLog(rows)
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({ questionType: 'ship_date', count: 2, firstSeen: '2026-09-01T00:00:00Z', lastSeen: '2026-09-03T00:00:00Z', messageIds: ['m1', 'm2'] })
    expect(c[0].missing).toBe('Confirmed ship date from Clopay (PO 2)')
    expect(c[1]).toMatchObject({ questionType: 'warranty', count: 1 })
  })
})

const ex = (o: Partial<StyleExample>): StyleExample => ({ id: 'x', source: 'staff', audience: 'partner', question_type: null, inquiry_text: null, ai_text: null, final_text: '', reply_id: null, is_pinned: false, is_deleted: false, created_at: '2026-09-01T00:00:00Z', ...o })

describe('pickStyleExamples', () => {
  const all = [
    ex({ id: 'pin', is_pinned: true, final_text: 'PO 12345 is scheduled for installation Tuesday.' }),
    ex({ id: 'sched', question_type: 'schedule', inquiry_text: 'When is the install scheduled for this customer?', final_text: 'Install is Thursday between 8 and 12.' }),
    ex({ id: 'material', question_type: 'material', inquiry_text: 'Did the replacement section arrive damaged?', final_text: 'The replacement section was ordered August 29.' }),
    ex({ id: 'del', is_deleted: true, question_type: 'schedule', inquiry_text: 'When is the install scheduled', final_text: 'deleted' }),
    ex({ id: 'edit', source: 'human_edit', question_type: 'schedule', inquiry_text: 'install date?', final_text: 'Scheduled Friday.' }),
  ]
  it('always includes pinned, then the most similar by wording and type, never deleted', () => {
    const picked = pickStyleExamples(all, 'schedule', 'Can you tell me when the install is scheduled for the customer?', 3).map(e => e.id)
    expect(picked[0]).toBe('pin')
    expect(picked).toContain('sched')
    expect(picked).not.toContain('del')
    expect(picked).toHaveLength(3)
  })
  it('prefers human-verified examples when wording ties', () => {
    const picked = pickStyleExamples(all, 'schedule', 'install date', 2).map(e => e.id)
    expect(picked).toEqual(['pin', 'edit'])
  })
})

describe('editRateByType', () => {
  it('computes unedited rate over human decisions and keeps auto separate', () => {
    const rows: EditRateRow[] = [
      { question_type: 'schedule', resolve_tier: 'po', status: 'sent', approval_path: 'approved', was_edited: false },
      { question_type: 'schedule', resolve_tier: 'po', status: 'sent', approval_path: 'approved', was_edited: false },
      { question_type: 'schedule', resolve_tier: 'po', status: 'sent', approval_path: 'edited', was_edited: true },
      { question_type: 'schedule', resolve_tier: 'po', status: 'rejected', approval_path: null, was_edited: false },
      { question_type: 'schedule', resolve_tier: 'po', status: 'sent', approval_path: 'auto', was_edited: false },
      { question_type: 'schedule', resolve_tier: 'po', status: 'draft', approval_path: null, was_edited: false },
    ]
    const r = editRateByType(rows)[0]
    expect(r).toMatchObject({ key: 'schedule:po', reviewed: 4, unedited: 2, edited: 1, rejected: 1, auto: 1 })
    expect(r.uneditedRate).toBeCloseTo(2 / 3)
  })
})
