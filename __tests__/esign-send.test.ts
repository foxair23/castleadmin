import { describe, it, expect } from 'vitest'
import { customerStageDue, daysBetween, ptDay, type DueInput } from '@/lib/esign/eligibility'
import { renderEsignCustomerSms, renderEsignCustomerEmail, renderEsignTechSms } from '@/lib/notifications/templates/esign-request'

const base: DueInput = {
  status: 'prepared', created_at: '2026-09-10T12:00:00Z', enabled_at: '2026-09-01T00:00:00Z',
  customer_sent_at: null, customer_asked_at: null, customer_reminded_at: null, customer_signed_at: null,
  start_date: '2026-09-15', today: '2026-09-15', hour: 9,
}
// PT noon on a given day, as an ISO instant.
const ptNoon = (day: string) => `${day}T19:00:00Z`

describe('customerStageDue', () => {
  it('sends the heads-up the morning of the work from 8am PT, not before', () => {
    expect(customerStageDue({ ...base, hour: 7 })).toBeNull()
    expect(customerStageDue({ ...base, hour: 8 })).toBe('heads_up')
    expect(customerStageDue({ ...base, today: '2026-09-14', hour: 16 })).toBeNull()   // day before: nothing
  })
  it('sends a late heads-up when the date was already past at first sight', () => {
    expect(customerStageDue({ ...base, today: '2026-09-17', hour: 10 })).toBe('heads_up')
  })
  it('asks the day after the work, never the same PT day as the heads-up', () => {
    const sentOnDay = { ...base, status: 'sent_customer', customer_sent_at: ptNoon('2026-09-15') }
    expect(customerStageDue({ ...sentOnDay, today: '2026-09-15', hour: 17 })).toBeNull()
    expect(customerStageDue({ ...sentOnDay, today: '2026-09-16', hour: 9 })).toBe('ask')
    // Late heads-up went out on the 17th (two days after): the ask waits for the 18th.
    const late = { ...base, status: 'sent_customer', customer_sent_at: ptNoon('2026-09-17') }
    expect(customerStageDue({ ...late, today: '2026-09-17', hour: 15 })).toBeNull()
    expect(customerStageDue({ ...late, today: '2026-09-18', hour: 9 })).toBe('ask')
  })
  it('reminds once, three days after the ask, then stops', () => {
    const asked = { ...base, status: 'sent_customer', customer_sent_at: ptNoon('2026-09-15'), customer_asked_at: ptNoon('2026-09-16') }
    expect(customerStageDue({ ...asked, today: '2026-09-18', hour: 9 })).toBeNull()
    expect(customerStageDue({ ...asked, today: '2026-09-19', hour: 9 })).toBe('reminder')
    expect(customerStageDue({ ...asked, customer_reminded_at: ptNoon('2026-09-19'), today: '2026-09-25', hour: 9 })).toBeNull()
  })
  it('never sends: signed, no job date, found before the cutoff, wrong status', () => {
    expect(customerStageDue({ ...base, customer_signed_at: ptNoon('2026-09-15') })).toBeNull()
    expect(customerStageDue({ ...base, start_date: null })).toBeNull()
    expect(customerStageDue({ ...base, created_at: '2026-08-20T00:00:00Z' })).toBeNull()
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
  it('delivery copy never mentions an installation', () => {
    for (const stage of ['heads_up', 'ask', 'reminder'] as const) {
      const sms = renderEsignCustomerSms(stage, 'delivery', o)
      const email = renderEsignCustomerEmail(stage, 'delivery', o)
      expect(sms).not.toMatch(/install/i); expect(email.subject + email.text).not.toMatch(/install/i)
      expect(sms).toContain('proof-of-delivery'); expect(sms).toContain(o.link)
    }
    expect(renderEsignCustomerSms('heads_up', 'delivery', o)).toContain('Your Home Depot delivery is scheduled soon')
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
