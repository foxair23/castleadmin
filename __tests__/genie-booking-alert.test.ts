import { describe, it, expect } from 'vitest'
import { renderGenieScheduleSyncFailure } from '@/lib/notifications/templates/genie-booking'

// The office is emailed only when the extension could not write a schedule to SF. Action
// Items already lists every booking, so there is no "booked" email at all.
const job = { sfJobNumber: '1020259248', customerName: 'Thien Huynh', hdOrder: '3865646', dateLabel: 'Tuesday, September 15', windowLabel: '8 AM – 4 PM (any time)', error: 'status was not saved (HTTP 500)' }

describe('renderGenieScheduleSyncFailure', () => {
  it('names every job that needs the schedule set by hand, with what to do', () => {
    const m = renderGenieScheduleSyncFailure({ jobs: [job, { ...job, sfJobNumber: '1020259251', customerName: null, hdOrder: '3865733', error: null }], adminUrl: 'https://x/admin/vendor-orders' })
    expect(m.subject).toBe('⚠ 2 Genie appointments need the schedule set in SF by hand')
    expect(m.bodyText).toContain('Job 1020259248 · Thien Huynh · HD #3865646 · Tuesday, September 15 · 8 AM – 4 PM (any time) — status was not saved (HTTP 500)')
    expect(m.bodyText).toContain('Job 1020259251 · HD #3865733 · HD #3865733')
    expect(m.bodyText).toMatch(/set the date and arrival window, and set the status to Scheduled/)
    expect(m.bodyHtml).toContain('Open HD Orders')
  })
  it('reads correctly for a single job', () => {
    expect(renderGenieScheduleSyncFailure({ jobs: [job], adminUrl: 'https://x' }).subject).toBe('⚠ 1 Genie appointment needs the schedule set in SF by hand')
  })
})
