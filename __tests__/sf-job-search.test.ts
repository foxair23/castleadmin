import { describe, it, expect } from 'vitest'
import { jobIdFromSearch } from '../chrome-extension/sf-remittance/sf-lines.js'

// SF's global search answers with JSON; the remittance flow has read it that way live for
// months. The job resolver was reading it as HTML and finding nothing.
describe('jobIdFromSearch', () => {
  const HASH = 'aBc123-XyZ_987'
  it('reads the JSON results the way the remittance flow does', () => {
    const body = JSON.stringify({ results: [
      { type: 'Customers', label: 'HUYNH, THIEN', value: 'cust-1' },
      { type: 'Jobs', label: 'Job #1020259248 · HUYNH, THIEN', value: HASH },
    ] })
    expect(jobIdFromSearch(body, '1020259248')).toBe(HASH)
  })
  it('prefers a URL on the result when there is one', () => {
    const body = JSON.stringify([{ type: 'job', label: '1020259248', url: `/jobs/jobView?id=${HASH}` , id: 555 }])
    expect(jobIdFromSearch(body, '1020259248')).toBe(HASH)
  })
  it('never returns the job number itself as the web id', () => {
    const body = JSON.stringify({ results: [{ type: 'Jobs', label: '1020259248', value: '1020259248' }] })
    expect(jobIdFromSearch(body, '1020259248')).toBeNull()
  })
  it('does not pick a different job that happens to be in the results', () => {
    const body = JSON.stringify({ results: [{ type: 'Jobs', label: 'Job #1020259251', value: 'other' }] })
    expect(jobIdFromSearch(body, '1020259248')).toBeNull()
  })
  it('still accepts the HTML link form, plain or JSON-escaped', () => {
    expect(jobIdFromSearch(`<a href="/jobs/jobView?id=${HASH}">1020259248</a>`, '1020259248')).toBe(HASH)
    expect(jobIdFromSearch(`{"html":"<a href=\\"\\/jobs\\/jobEdit?id=${HASH}\\">x<\\/a>"}`, '1020259248')).toBe(HASH)
  })
  it('returns null for an empty or unrelated response', () => {
    expect(jobIdFromSearch('{"results":[]}', '1020259248')).toBeNull()
    expect(jobIdFromSearch('<html>login</html>', '1020259248')).toBeNull()
  })
})
