import { describe, it, expect } from 'vitest'
import { customerStageDue, decideCustomerStage, daysBetween, ptDay, type DueInput } from '@/lib/esign/eligibility'
import { renderEsignCustomerSms, renderEsignCustomerEmail, renderEsignTechSms } from '@/lib/notifications/templates/esign-request'

const base: DueInput = {
  status: 'prepared', created_at: '2026-09-10T12:00:00Z', enabled_at: '2026-09-01T00:00:00Z',
  customer_sent_at: null, customer_asked_at: null, customer_reminded_at: null, customer_signed_at: null,
  start_date: '2026-09-15', today: '2026-09-15', hour: 9, sof: 'needed',
}
// PT noon on a given day, as an ISO instant.
const ptNoon = (day: string) => `${day}T19:00:00Z`

describe('customerStageDue', () => {
  it('sends the heads-up the morning of the work from 8am PT, not before', () => {
    expect(customerStageDue({ ...base, hour: 7 })).toBeNull()
    expect(customerStageDue({ ...base, hour: 8 })).toBe('heads_up')
    expect(customerStageDue({ ...base, today: '2026-09-14', hour: 16 })).toBeNull()   // day before: nothing
  })
  it('a date that passed without completion is a wait, not a late heads-up', () => {
    expect(customerStageDue({ ...base, today: '2026-09-17', hour: 10, completed: false })).toBeNull()
  })
  it('nothing goes out on a job the office has not marked "HD SOF Needed"', () => {
    expect(customerStageDue({ ...base, sof: null })).toBeNull()          // no sub-status at all
    expect(customerStageDue({ ...base, sof: 'sent' })).toBeNull()        // already ours
    expect(customerStageDue({ ...base, sof: 'complete' })).toBeNull()
    expect(customerStageDue({ ...base, sof: undefined })).toBeNull()     // live read gave us nothing
  })
  it('back on "HD SOF Needed" after our write landed is the office asking again', () => {
    const sent = { ...base, status: 'sent_customer', customer_sent_at: ptNoon('2026-09-15'), today: '2026-09-20', hour: 9, completed: false }
    // Our own write confirmed, and SF reads Needed again: someone moved it back on purpose.
    expect(customerStageDue({ ...sent, sof: 'needed', sub_status_set_at: ptNoon('2026-09-15') })).toBe('heads_up')
    // Same, but our write has not been confirmed yet — this is just the gap, not a request.
    expect(customerStageDue({ ...sent, sof: 'needed', sub_status_set_at: null })).toBeNull()
    // Sitting on Sent, as it should be: nothing.
    expect(customerStageDue({ ...sent, sof: 'sent', sub_status_set_at: ptNoon('2026-09-15') })).toBeNull()
  })
  it('asks when the work is marked complete — even with no heads-up, and not the same morning as one', () => {
    expect(customerStageDue({ ...base, completed: true, today: '2026-09-15', hour: 14 })).toBe('ask')
    const sentOnDay = { ...base, status: 'sent_customer', customer_sent_at: ptNoon('2026-09-15'), completed: true }
    expect(customerStageDue({ ...sentOnDay, today: '2026-09-15', hour: 14 })).toBeNull()
    expect(customerStageDue({ ...sentOnDay, today: '2026-09-15', hour: 18 })).toBe('ask')
    expect(customerStageDue({ ...sentOnDay, today: '2026-09-16', hour: 9 })).toBe('ask')
    // Not complete yet: no ask, however many days have passed.
    expect(customerStageDue({ ...sentOnDay, completed: false, today: '2026-09-20', hour: 9 })).toBeNull()
  })
  it('without a live read (completion unknown) falls back to the day after the date', () => {
    const sentOnDay = { ...base, status: 'sent_customer', customer_sent_at: ptNoon('2026-09-15') }
    expect(customerStageDue({ ...sentOnDay, today: '2026-09-15', hour: 17 })).toBeNull()
    expect(customerStageDue({ ...sentOnDay, today: '2026-09-16', hour: 9 })).toBe('ask')
  })
  it('"HD SOF Needed" overrides the job\'s own status — that is the whole point of it', () => {
    // A job parked on "Waiting on Clopay" used to be silenced by its status. The office
    // marking it is an instruction, so it sends.
    expect(customerStageDue({ ...base, sof: 'needed', completed: false, hour: 9 })).toBe('heads_up')
  })
  it('reminds once, three days after the ask, then stops', () => {
    const asked = { ...base, status: 'sent_customer', customer_sent_at: ptNoon('2026-09-15'), customer_asked_at: ptNoon('2026-09-16'), completed: true, sof: 'sent' as const }
    expect(customerStageDue({ ...asked, today: '2026-09-18', hour: 9 })).toBeNull()
    expect(customerStageDue({ ...asked, today: '2026-09-19', hour: 9 })).toBe('reminder')
    expect(customerStageDue({ ...asked, customer_reminded_at: ptNoon('2026-09-19'), today: '2026-09-25', hour: 9 })).toBeNull()
  })
  it('the office marking a job beats the auto-send cutoff — the real cause of the 1020258680 miss', () => {
    // That blank was captured on 9 Sep; auto-send was switched on late on 14 Sep. The cutoff
    // is there so flipping the switch does not mail ~200 old blanks — but a job someone has
    // deliberately marked HD SOF Needed is not one of those, and used to be silenced anyway.
    const old = { ...base, created_at: '2026-09-10T03:16:24Z', enabled_at: '2026-09-15T05:46:55Z' }
    expect(customerStageDue({ ...old, sof: 'needed' })).toBe('heads_up')
    // Unmarked and older than the cutoff: still quiet. That is the protection, kept.
    expect(customerStageDue({ ...old, sof: null })).toBeNull()
    expect(customerStageDue({ ...old, sof: null, completed: true })).toBeNull()
    // Once we have written to this customer, the ask and the reminder may follow their own
    // heads-up even though the blank predates the cutoff.
    expect(customerStageDue({ ...old, sof: 'sent', customer_sent_at: ptNoon('2026-09-15'), completed: true, today: '2026-09-16' })).toBe('ask')
  })
  it('never sends: signed, no job date, found before the cutoff, wrong status', () => {
    expect(customerStageDue({ ...base, customer_signed_at: ptNoon('2026-09-15') })).toBeNull()
    expect(customerStageDue({ ...base, start_date: null })).toBeNull()
    expect(customerStageDue({ ...base, created_at: '2026-08-20T00:00:00Z', sof: null })).toBeNull()
    expect(customerStageDue({ ...base, enabled_at: null })).toBeNull()
    expect(customerStageDue({ ...base, status: 'unrecognised_template' })).toBeNull()
    expect(customerStageDue({ ...base, status: 'customer_signed' })).toBeNull()
  })
  it('counts PT calendar days', () => {
    expect(daysBetween('2026-09-15', '2026-09-18')).toBe(3)
    expect(daysBetween('2026-09-30', '2026-10-01')).toBe(1)
    expect(ptDay('2026-09-16T05:30:00Z')).toBe('2026-09-15')   // 10:30pm PT the day before
  })
})

describe('e-sign messages', () => {
  const o = { greetingName: 'Sergio', link: 'https://go.cstle.co/AbC12345' }
  it('install copy is the approved wording, verbatim', () => {
    expect(renderEsignCustomerSms('heads_up', 'install', o)).toBe("Hi Sergio, it's Castle Garage Doors. Your garage door installation is scheduled soon. Home Depot requires a signed completion form for the work — we're sending it now so you have it. Once your installation is complete, please come back here to review and e-sign it: https://go.cstle.co/AbC12345. Reply STOP to opt out.")
    expect(renderEsignCustomerSms('ask', 'install', o)).toBe('Hi Sergio, now that your garage door installation is complete, Home Depot needs your e-signature on the completion form. It takes about a minute: https://go.cstle.co/AbC12345')
    expect(renderEsignCustomerSms('reminder', 'install', o)).toBe("Quick reminder from Castle Garage Doors — Home Depot's completion form for your garage door installation is still waiting for your e-signature: https://go.cstle.co/AbC12345")
    const e = renderEsignCustomerEmail('heads_up', 'install', o)
    expect(e.subject).toBe('Your Home Depot completion form — for after your installation')
    expect(e.text).toContain('Please wait until the installation is finished before signing.')
    expect(renderEsignCustomerEmail('ask', 'install', o).subject).toBe('Your installation is complete — please e-sign the Home Depot completion form')
  })
  it('delivery copy is the approved wording, verbatim', () => {
    // Approved 2026-09-15. A delivery has no "work": the heads-up does not say "for the
    // work", and the reminder says "your delivery" rather than the vaguer "your order".
    expect(renderEsignCustomerSms('heads_up', 'delivery', o)).toBe("Hi Sergio, it's Castle Garage Doors. Your delivery is scheduled soon. Home Depot requires a signed proof-of-delivery form — we're sending it now so you have it. Once your delivery is complete, please come back here to review and e-sign it: https://go.cstle.co/AbC12345. Reply STOP to opt out.")
    expect(renderEsignCustomerSms('ask', 'delivery', o)).toBe('Hi Sergio, now that your Home Depot delivery is complete, Home Depot needs your e-signature on the proof-of-delivery form. It takes about a minute: https://go.cstle.co/AbC12345')
    expect(renderEsignCustomerSms('reminder', 'delivery', o)).toBe("Quick reminder from Castle Garage Doors — Home Depot's proof-of-delivery form for your delivery is still waiting for your e-signature: https://go.cstle.co/AbC12345")
    const e = renderEsignCustomerEmail('heads_up', 'delivery', o)
    expect(e.subject).toBe('Your Home Depot proof-of-delivery form — for after your delivery')
    expect(e.text).toContain('Please wait until the delivery is finished before signing.')
    expect(renderEsignCustomerEmail('ask', 'delivery', o).subject).toBe('Your delivery is complete — please e-sign the Home Depot proof-of-delivery form')
  })
  it('delivery copy never mentions an installation', () => {
    for (const stage of ['heads_up', 'ask', 'reminder'] as const) {
      const sms = renderEsignCustomerSms(stage, 'delivery', o)
      const email = renderEsignCustomerEmail(stage, 'delivery', o)
      expect(sms).not.toMatch(/install/i); expect(email.subject + email.text).not.toMatch(/install/i)
      expect(sms).toContain('proof-of-delivery'); expect(sms).toContain(o.link)
    }
  })
  it('heads-up carries the no-date, come-back-after promise and STOP; the link is in every message', () => {
    for (const service of ['install', 'delivery'] as const) {
      const sms = renderEsignCustomerSms('heads_up', service, o)
      expect(sms).toMatch(/Reply STOP to opt out\.$/)
      expect(sms).not.toMatch(/\d{1,2}\/\d{1,2}/)
      expect(renderEsignCustomerEmail('reminder', service, o).html).toContain(o.link)
    }
    expect(renderEsignCustomerSms('ask', 'install', { greetingName: null, link: 'x' })).toMatch(/^Hi, now that/)
  })
  it('tech message names the customer, address and job', () => {
    expect(renderEsignTechSms('install', { customerName: 'Sergio Velasco', address: '1334 O Ave, National City', jobNumber: '1020259248', link: 'https://x/sign/t' }))
      .toBe('Sergio Velasco at 1334 O Ave, National City has signed the Home Depot completion form for job 1020259248. Please add your signature: https://x/sign/t')
  })
})

// The four real Clopay jobs the rule was pinned on (live SF reads, 2026-09-12).
import { deriveWork } from '@/lib/esign/work'
import { sofStageOf, SOF_NEEDED, SOF_SENT, SOF_COMPLETE } from '@/lib/esign/sub-status'
import type { LiveJobFacts } from '@/lib/agent/live-refresh'
const job = (o: Partial<LiveJobFacts>): LiveJobFacts => ({ jobId: '1', jobNumber: '1', status: null, subStatus: null, category: null, description: null, visits: [], customerName: null, poNumber: null, startDate: null, endDate: null, windowStart: null, windowEnd: null, completedAt: null, techs: [], city: null, postalCode: null, requiresFollowUp: false, updatedAtSf: null, fetchedAt: 'x', ...o })
const visit = (startDate: string, notes: string | null, techStatus: string) => ({ startDate, windowStart: null, windowEnd: null, notes, techs: [], techStatus })
// The four real Clopay jobs the timing was first pinned on. What decides now is the office's
// HD SOF sub-status, not the category or the status — which is exactly why these jobs are
// still the fixtures: each one fooled a status-reading rule at some point.
describe('the real Clopay jobs, under the HD SOF sub-status rule', () => {
  const at = (f: LiveJobFacts) => ({ sof: sofStageOf(f.subStatus), work: deriveWork(f, 'install') })
  it('1020256603: unmarked, so nothing is sent whatever the visit says', () => {
    const f = job({ status: 'Waiting for Tiffany', category: 'CLOPAY: Inspection', startDate: '2026-08-25', description: 'HD cust door install', visits: [visit('2026-08-25', 'HD cust site inspection', 'Waiting for Tiffany')] })
    const { sof, work } = at(f)
    expect(sof).toBeNull(); expect(work.completed).toBe(false)
    expect(customerStageDue({ ...base, sof, completed: work.completed, start_date: work.workDate, today: '2026-08-25', hour: 9 })).toBeNull()
  })
  it('1020259141: unmarked "Site Check" — nothing is sent', () => {
    const f = job({ status: 'Waiting on Clopay', category: 'CLOPAY: Inspection', description: 'HD install', visits: [visit('2026-09-09', 'Site Check', 'Waiting on Clopay')] })
    const { sof, work } = at(f)
    expect(customerStageDue({ ...base, sof, completed: work.completed, start_date: work.workDate, today: '2026-09-09', hour: 9 })).toBeNull()
  })
  it('1020259079: the category said Installation and the visit was really the site check — still nothing, because nobody marked it', () => {
    const f = job({ status: 'Waiting on Clopay', category: 'CLOPAY: Door/Segment Installation', description: 'HD door installation', visits: [visit('2026-08-27', null, 'Waiting on Clopay')] })
    const { sof, work } = at(f)
    expect(customerStageDue({ ...base, sof, completed: work.completed, start_date: work.workDate, today: '2026-08-27', hour: 9 })).toBeNull()
  })
  it('the office marks that same waiting job "HD SOF Needed" — the heads-up goes that morning', () => {
    const f = job({ status: 'Waiting on Clopay', subStatus: 'HD SOF Needed', category: 'CLOPAY: Door/Segment Installation', visits: [visit('2026-09-20', 'HD door install', 'Waiting on Clopay')] })
    const { sof, work } = at(f)
    expect(sof).toBe('needed')
    const d = { ...base, sof, completed: work.completed, start_date: work.workDate }
    expect(customerStageDue({ ...d, today: '2026-09-19', hour: 9 })).toBeNull()      // the day before
    expect(customerStageDue({ ...d, today: '2026-09-20', hour: 7 })).toBeNull()      // too early
    expect(customerStageDue({ ...d, today: '2026-09-20', hour: 9 })).toBe('heads_up')
    expect(customerStageDue({ ...d, status: 'sent_customer', sof: 'sent', customer_sent_at: ptNoon('2026-09-20'), today: '2026-09-25', hour: 9 })).toBeNull()
  })
  it('1020258612: install complete (visit Completed, job Invoiced) — ask now, marked or not', () => {
    const w = deriveWork(job({ status: 'Invoiced', startDate: '2026-08-14', completedAt: '2026-08-19T10:35:10+00:00', description: 'HD Customer Installation', visits: [visit('2026-07-07', 'HD Customer- Door install', 'Completed')] }), 'install')
    expect(w).toMatchObject({ phase: 'install', completed: true })
    // Completion is its own authority: the customer has had the work done, so the form is
    // due whatever the sub-status says. Only the HEADS-UP waits on the office.
    expect(customerStageDue({ ...base, sof: null, completed: w.completed, start_date: w.workDate, today: '2026-09-12', hour: 9 })).toBe('ask')
  })
})

describe('sofStageOf', () => {
  it('reads the three HD SOF sub-statuses, and nothing else', () => {
    expect(sofStageOf(SOF_NEEDED)).toBe('needed')
    expect(sofStageOf(SOF_SENT)).toBe('sent')
    expect(sofStageOf(SOF_COMPLETE)).toBe('complete')
    // Tolerant of how it was typed into SF settings.
    expect(sofStageOf('  hd sof   needed ')).toBe('needed')
    // Everything else is "not marked", never a guess.
    expect(sofStageOf('Waiting on Clopay')).toBeNull()
    expect(sofStageOf('HD SOF')).toBeNull()
    expect(sofStageOf(null)).toBeNull()
    expect(sofStageOf('')).toBeNull()
  })
})


// Every hold now carries its own explanation, stored on the document and shown on the
// Signatures page — this wording is what the office reads when a form did not go out.
describe('decideCustomerStage explains itself', () => {
  const base: DueInput = {
    status: 'prepared', created_at: '2026-09-16T03:00:00Z', enabled_at: '2026-09-15T05:46:00Z',
    customer_sent_at: null, customer_asked_at: null, customer_reminded_at: null, customer_signed_at: null,
    start_date: '2026-09-17', today: '2026-09-17', hour: 9, sof: 'needed',
  }
  it('names the sub-status when the office has not asked for the form', () => {
    const d = decideCustomerStage({ ...base, sof: null })
    expect(d.stage).toBeNull()
    expect(d.reason).toMatch(/sub-status is not set/)
  })
  it('names the work date when it is not today', () => {
    const d = decideCustomerStage({ ...base, start_date: '2026-06-29' })
    expect(d.stage).toBeNull()
    expect(d.reason).toContain('2026-06-29')
  })
  it('names the cutoff when the blank predates auto-send', () => {
    expect(decideCustomerStage({ ...base, created_at: '2026-09-10T03:16:00Z', sof: null }).reason)
      .toMatch(/before auto-send was switched on/)
  })
  it('explains a send, not just a hold', () => {
    const d = decideCustomerStage(base)
    expect(d.stage).toBe('heads_up')
    expect(d.reason).toMatch(/HD SOF Needed/)
  })
})


// A Clopay job carries several visits at once — a site check, the install, a return trip —
// and the office marks "HD SOF Needed" for the one being worked. Keying on the LATEST visit
// held the form back on the day a customer was actually being visited.
describe('any visit scheduled today releases the heads-up', () => {
  const base: DueInput = {
    status: 'prepared', created_at: '2026-09-16T03:00:00Z', enabled_at: '2026-09-15T00:00:00Z',
    customer_sent_at: null, customer_asked_at: null, customer_reminded_at: null, customer_signed_at: null,
    start_date: '2026-10-02', today: '2026-09-18', hour: 9, sof: 'needed',
  }
  it('sends when one of several visits is today, even though the latest is not', () => {
    const d = decideCustomerStage({ ...base, start_dates: ['2026-08-20', '2026-09-18', '2026-10-02'] })
    expect(d.stage).toBe('heads_up')
    expect(d.reason).toContain('2026-09-18')
  })
  it('holds when no visit is today, and names the dates', () => {
    const d = decideCustomerStage({ ...base, start_dates: ['2026-08-20', '2026-10-02'] })
    expect(d.stage).toBeNull()
    expect(d.reason).toContain('2026-08-20')
    expect(d.reason).toContain('2026-10-02')
  })
  it('still waits for 8am on the day itself', () => {
    expect(decideCustomerStage({ ...base, start_dates: ['2026-09-18'], hour: 7 }).stage).toBeNull()
  })
  it('falls back to the single date when no live read gave us the visits', () => {
    expect(decideCustomerStage({ ...base, start_date: '2026-09-18', start_dates: null }).stage).toBe('heads_up')
    expect(decideCustomerStage({ ...base, start_date: '2026-10-02', start_dates: null }).stage).toBeNull()
  })
  it('still needs the office marking, whatever the dates say', () => {
    expect(decideCustomerStage({ ...base, start_dates: ['2026-09-18'], sof: 'sent' }).stage).toBeNull()
  })
})
