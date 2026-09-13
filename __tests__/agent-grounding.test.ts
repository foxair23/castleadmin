import { describe, it, expect } from 'vitest'
import { checkGrounding, concreteValues } from '@/lib/agent/email/grounding-check'
import { factsFromLive, fmtDay, fmtTime, pickAnswers, type Fact } from '@/lib/agent/email/grounding'
import { renderBody, renderEmail, buildComposeMessages } from '@/lib/agent/email/compose'
import { mapLiveJob } from '@/lib/agent/live-refresh'
import { AGENT_DEFAULTS } from '@/lib/agent/settings'
import type { AnswerEntry } from '@/lib/agent/knowledge'

const live = mapLiveJob({
  id: 1096589732, number: '1020259225', status: 'Scheduled', sub_status: 'Confirmed', customer_name: 'COOREY, MARK', po_number: '1020259181, 1020259182',
  start_date: '2026-09-08 08:00:00', end_date: '2026-09-08 12:00:00', time_frame_promised_start: '08:00', time_frame_promised_end: '12:00',
  techs_assigned: [{ id: 41, first_name: 'Luis', last_name: 'Ramirez' }],
}, '2026-09-07T10:00:00Z')
const facts: Fact[] = factsFromLive(live, 'Job 1020259225').map((f, i) => ({ ...f, id: `F${i + 1}` }))

describe('facts from a live read', () => {
  it('renders dates and windows the way a partner reads them', () => {
    expect(fmtDay('2026-09-08 08:00:00')).toBe('Tuesday, September 8')
    expect(fmtTime('08:00')).toBe('8:00 AM')
    expect(fmtTime('2026-09-08 13:30:00')).toBe('1:30 PM')
    const sched = facts.find(f => f.label.endsWith('schedule'))!
    expect(sched.text).toBe('The appointment is scheduled for Tuesday, September 8 with an arrival window of 8:00 AM to 12:00 PM.')
    expect(facts.find(f => f.label.endsWith('technician'))!.text).toBe('Assigned technician: Luis Ramirez.')
  })
  it('says plainly when there is nothing', () => {
    const bare = factsFromLive(mapLiveJob({ id: 1, status: 'Unscheduled', techs_assigned: [] }), 'Job 1')
    expect(bare.map(f => f.text)).toContain('There is no appointment date on the job yet.')
    expect(bare.map(f => f.text)).toContain('No technician is assigned yet.')
  })
})

describe('concreteValues', () => {
  it('finds dates, weekdays, times, money, long numbers, and names', () => {
    const v = concreteValues('PO 1020259181 is scheduled for Tuesday, September 8 between 8:00 AM and 12 PM. Luis Ramirez is assigned. Total $1,041.00.')
    expect(v).toEqual(expect.arrayContaining(['1020259181', 'Tuesday, September 8', '8:00 AM', '12 PM', 'Luis Ramirez', '$1,041.00']))
  })
  it('a sentence with no concrete content has none', () => {
    expect(concreteValues('Let me know if anything changes on your end.')).toEqual([])
    expect(concreteValues('Thank you for reaching out to Castle Garage Doors.')).toEqual([])
  })
})

describe('checkGrounding', () => {
  it('passes a reply whose every value is in a cited fact', () => {
    const r = checkGrounding([
      { text: 'PO 1020259181 is scheduled for install Tuesday, September 8 with an arrival window of 8:00 AM to 12:00 PM.', factIds: ['F2', 'F6'] },
      { text: 'Luis Ramirez is the assigned technician.', factIds: ['F4'] },
      { text: 'Let us know if anything changes on your end.', factIds: [] },
    ], facts)
    expect(r.unsourced).toEqual([])
    expect(r.fullyGrounded).toBe(true)
  })
  it('flags an invented date even when a fact is cited', () => {
    const r = checkGrounding([{ text: 'The replacement panel should arrive Thursday, September 10.', factIds: ['F2'] }], facts)
    expect(r.fullyGrounded).toBe(false)
    expect(r.unsourced[0]).toMatch(/"Thursday, September 10"/)
  })
  it('flags concrete values with no citation at all', () => {
    const r = checkGrounding([{ text: 'The install is set for Tuesday, September 8.', factIds: [] }], facts)
    expect(r.claims[0].grounded).toBe(false)
    expect(r.unsourced).toHaveLength(1)
  })
  it('flags a name that is not in the facts', () => {
    const r = checkGrounding([{ text: 'Sam Kowalski will be your technician.', factIds: ['F4'] }], facts)
    expect(r.unsourced[0]).toMatch(/Sam Kowalski/)
  })
  it('a fully generic reply is not "grounded" — no fact was actually used', () => {
    const r = checkGrounding([{ text: 'Thanks, we will look into it and follow up.', factIds: [] }], facts)
    expect(r.unsourced).toEqual([])
    expect(r.fullyGrounded).toBe(false)
  })
  it('tolerates "September 8th" and "8 AM" spellings of a supported value', () => {
    const r = checkGrounding([{ text: 'Install is September 8th, arrival 8 AM to 12 PM.', factIds: ['F2'] }], facts)
    expect(r.unsourced).toEqual([])
  })
  it('a citation to a non-existent fact id counts as no citation', () => {
    const r = checkGrounding([{ text: 'Scheduled Tuesday, September 8.', factIds: ['F99'] }], facts)
    expect(r.claims[0].grounded).toBe(false)
  })
})

describe('rendering', () => {
  it('joins sentences and honours paragraph breaks, then wraps with greeting and disclosure', () => {
    const body = renderBody([{ text: 'Found it.', factIds: [] }, { text: 'Install is Tuesday.', factIds: ['F2'] }, { text: '\nLuis is assigned.', factIds: ['F4'] }])
    expect(body).toBe('Found it. Install is Tuesday.\n\nLuis is assigned.')
    const email = renderEmail(body, AGENT_DEFAULTS, 'Jane')
    expect(email.startsWith('Hi Jane,\n\nFound it.')).toBe(true)
    expect(email).toContain(AGENT_DEFAULTS.signature_text)
    expect(email).toContain(AGENT_DEFAULTS.escape_hatch_text)
  })
  it('composer prompt lists facts by id and caches the charter block', () => {
    const { system, user } = buildComposeMessages({
      settings: AGENT_DEFAULTS, charter: { id: 'c', version: 3, body: 'CHARTER TEXT', note: null, is_active: true, created_at: '', channel: 'email' },
      instructions: [{ id: 'i1', text: 'Always give the arrival window.', channel: 'email', is_active: true, created_at: '', retired_at: null }, { id: 'i2', text: 'Phone only rule', channel: 'phone', is_active: true, created_at: '', retired_at: null }],
      styleExamples: [], facts, gaps: [], questionType: 'schedule', questionSummary: 'When is PO 1020259181 scheduled?',
      partner: { fromName: 'Jane Doe', fromAddr: 'jane@homedepot.com', company: 'Home Depot' }, subject: 'PO status', body: 'When is it?', thread: [],
    })
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(system[0].text).toContain('CHARTER TEXT')
    expect(system[1].text).toContain('Always give the arrival window.')
    expect(system[1].text).not.toContain('Phone only rule')
    expect(user).toContain('F2 [Job 1020259225 · schedule]')
    expect(user).toContain('Question type: schedule')
  })
})

describe('pickAnswers', () => {
  const lib = (o: Partial<AnswerEntry>): AnswerEntry => ({ id: 'x', title: '', question_examples: [], question_type: null, answer_text: '', audience: 'partner', is_active: true, source_chat_ask_id: null, created_at: '', updated_at: '', ...o })
  it('prefers same-type entries and keyword overlap; skips customer-only and inactive', () => {
    const all = [
      lib({ id: 'a', title: 'Permit handling', question_examples: ['who pulls the permit'], question_type: 'other' }),
      lib({ id: 'b', title: 'Typical lead time', question_examples: ['how long until install'], question_type: 'schedule' }),
      lib({ id: 'c', title: 'Customer-facing', question_type: 'schedule', audience: 'customer' }),
      lib({ id: 'd', title: 'Old', question_type: 'schedule', is_active: false }),
    ]
    expect(pickAnswers(all, 'schedule', 'How long until the install happens?').map(a => a.id)).toEqual(['b'])
    expect(pickAnswers(all, 'other', 'Who is pulling the permit for this job?').map(a => a.id)).toEqual(['a'])
  })
})
