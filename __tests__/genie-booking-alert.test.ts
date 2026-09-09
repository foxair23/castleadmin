import { describe, it, expect } from 'vitest'
import { renderGenieBookingAlert } from '@/lib/notifications/templates/genie-booking'

const base = { customerName: 'Thien Huynh', phone: null, email: null, hdOrder: '3865646', sfJobNumber: '1020259248', dateLabel: 'Tuesday, September 15', windowLabel: 'Any time', address: null, adminUrl: 'https://x/admin/vendor-orders' }

// The date now reaches SF via the extension, minutes after booking. The alert has to say
// "pending" — not "failed", which tells the office to do by hand what is about to happen.
describe('renderGenieBookingAlert sync states', () => {
  it('pending: booked, SF date on its way, no ACTION NEEDED', () => {
    const a = renderGenieBookingAlert({ ...base, sync: 'pending' })
    expect(a.subject).toContain('SF date pending')
    expect(a.bodyText).toMatch(/being written to the SF job/)
    expect(a.bodyText).not.toMatch(/ACTION NEEDED/)
  })
  it('failed: still the manual instruction', () => {
    const a = renderGenieBookingAlert({ ...base, sync: 'failed', syncError: 'queue write failed' })
    expect(a.subject).toContain('NOT synced')
    expect(a.bodyText).toMatch(/ACTION NEEDED/)
  })
  it('keeps the older boolean form working', () => {
    expect(renderGenieBookingAlert({ ...base, synced: false }).subject).toContain('NOT synced')
    expect(renderGenieBookingAlert({ ...base }).subject).toBe('Genie install booked: Thien Huynh — Tuesday, September 15')
  })
})
