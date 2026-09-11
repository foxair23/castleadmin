import { describe, it, expect } from 'vitest'
import { renderHealthAlert, renderHealthDigest, conditionLabel } from '@/lib/notifications/templates/automation-health'
import type { HealthReport } from '@/lib/ops/health'

const report: HealthReport = {
  at: '2026-09-15T17:00:00Z', overall: 'red',
  conditions: [{ key: 'extension_silent', card: 'extension', state: 'red', detail: 'office-mac last seen 2 h ago (v0.9.16)' }, { key: 'genie_list_stale', card: 'genie', state: 'red', detail: 'last list crawl 7 h ago' }],
  cards: [{ key: 'extension', label: 'Extension', state: 'red', lines: ['✗ office-mac last seen 2 h ago'] }],
  checklist: [{ key: 'manual', label: 'Machine settings confirmed', ok: false }],
}
describe('automation health mail', () => {
  it('names the condition, carries the detail and advice, and lists other reds already reported', () => {
    const m = renderHealthAlert([{ condition: 'extension_silent', kind: 'red', detail: report.conditions[0].detail }], report)
    expect(m.subject).toBe('🔴 Automation: Extension not reporting')
    expect(m.bodyText).toContain('office-mac last seen 2 h ago')
    expect(m.bodyText).toContain('Nothing can be done remotely')
    expect(m.bodyText).toContain('Still red (already reported): Genie list crawl stale')
    expect(m.bodyText).toContain('/admin/ops')
  })
  it('recovered mail reads green', () => {
    const m = renderHealthAlert([{ condition: 'login_failed:clopay', kind: 'recovered', detail: 'Clopay session ok' }], { ...report, overall: 'green', conditions: [] })
    expect(m.subject).toBe('🟢 Automation recovered: Auto-login to clopay failing')
  })
  it('digest carries the colour, every card, yesterday, and the incomplete checklist', () => {
    const m = renderHealthDigest(report, { genie: { crawls: 12, done: 11, detailed: 240 }, clopay: { crawls: 12, done: 12, detailed: 190, docsStored: 8 }, sf: { runs: 60, failed: 0, applied: 3, notes: 5, lines: 1, appointments: 2, docs: 0 }, logins: { failed: 0 } }, 'Monday, September 14')
    expect(m.subject).toContain('RED')
    expect(m.bodyText).toContain('240 orders detailed')
    expect(m.bodyText).toContain('Checklist not complete: Machine settings confirmed')
  })
  it('labels every condition family', () => {
    expect(conditionLabel('queue_stale:notes')).toBe('SF notes queue stuck')
    expect(conditionLabel('crawl_never_finishes:genie')).toBe('genie crawls not finishing')
  })
})
