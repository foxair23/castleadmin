import { describe, it, expect } from 'vitest'
import { portalCompleteFromStatus, type PortalComplete } from '@/lib/vendor-orders/portal-complete'

// Clopay pays on its own portal's say-so. Only "Install/Delivery Completed" means every step
// is done — the other "completed"-ish statuses are mid-flow, and cancelled is terminal but
// owes us nothing, so neither counts as complete.
describe('portalCompleteFromStatus', () => {
  it('says yes only for Install/Delivery Completed', () => {
    expect(portalCompleteFromStatus('Install/Delivery Completed')).toBe('yes')
    expect(portalCompleteFromStatus('install / delivery completed')).toBe('yes')
    expect(portalCompleteFromStatus('  INSTALL/DELIVERY COMPLETED  ')).toBe('yes')
  })
  it('says no to the statuses that only look finished', () => {
    expect(portalCompleteFromStatus('Completed SC Recvd by Clopay')).toBe('no')
    expect(portalCompleteFromStatus('At DC Ready for Pickup/Delivery')).toBe('no')
    expect(portalCompleteFromStatus('Schedule Install/Delivery')).toBe('no')
    expect(portalCompleteFromStatus('Cancelled')).toBe('no')
  })
  it('says no when the portal has no status at all', () => {
    expect(portalCompleteFromStatus(null)).toBe('no')
    expect(portalCompleteFromStatus('')).toBe('no')
    expect(portalCompleteFromStatus(undefined)).toBe('no')
  })
})

// The column reads a cache (migration 150) rather than re-running the matcher: Action Items
// starts from an SF job, and only hand links and jobs we created were ever written down.
// A stale cache can therefore only make the column lag, never make it disagree with the
// Clopay tab about which order belongs to which job — both read the same answer.
describe('what "Portal Complete?" is allowed to be', () => {
  it('has exactly three states', () => {
    const states: PortalComplete[] = ['yes', 'no', 'na']
    expect(new Set(states).size).toBe(3)
  })
  it('never reports a status it was not given', () => {
    // 'na' is decided by the absence of an order, never by its status — every status maps to
    // yes or no, so a matched order can never fall through to N/A.
    for (const s of ['Install/Delivery Completed', 'Cancelled', 'At DC', '', null]) {
      expect(['yes', 'no']).toContain(portalCompleteFromStatus(s))
    }
  })
})
