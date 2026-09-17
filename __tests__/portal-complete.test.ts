import { describe, it, expect } from 'vitest'
import { portalCompleteFromStatus } from '@/lib/vendor-orders/portal-complete'

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
