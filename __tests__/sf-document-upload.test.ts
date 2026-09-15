import { describe, it, expect } from 'vitest'
import { customerIdFromJobPage, parseCustomerDocuments, findUploadedDocId, attachSucceeded, fileKey } from '../chrome-extension/sf-remittance/sf-document.js'

// All captured from a real job on 2026-09-15, kept verbatim so a change on SF's side fails
// here before it fails on a customer's signed form.
const CUSTOMER = 'lrQRuhEhu0Zt82mNhG07637qSeJ9NeNT8FdpIOf56Fo'
const JOB_PAGE = `
  <input type="hidden" id="customer_id" value="${CUSTOMER}">
  <a href="/customer/editCustomer?id=${CUSTOMER}">Acme</a>
  <div data-customer-id='${CUSTOMER}'></div>`

const DOCUMENTS = `
<div class="control-group span12">
	<div class="span6">
		<select class='span12' id='documents-list'><option value='default'>Select existing document or add new</option>					<option value='33715621'>141684432.pdf</option>
									<option value='34351989'>Oson, Christopher waiver.pdf</option>
									<option value='34695322'>Screenshot 2026-09-14 at 8.42.13 PM.png</option>
				</select>
	</div>
</div>`

describe('customerIdFromJobPage', () => {
  // Documents belong to the CUSTOMER; the job only links to one. Without this id there is
  // nowhere to upload to, so three different spellings of it are accepted.
  it('finds the customer on the job page', () => {
    expect(customerIdFromJobPage(JOB_PAGE)).toBe(CUSTOMER)
    expect(customerIdFromJobPage(`<a href="/customer/editCustomer?id=${CUSTOMER}">x</a>`)).toBe(CUSTOMER)
    expect(customerIdFromJobPage(`<tr data-customer-id='${CUSTOMER}'>`)).toBe(CUSTOMER)
  })
  it('is null on a page that is not a job', () => {
    expect(customerIdFromJobPage('<html>login</html>')).toBeNull()
    expect(customerIdFromJobPage('')).toBeNull()
  })
})

describe('parseCustomerDocuments', () => {
  it('lists the customer library and skips the placeholder', () => {
    const docs = parseCustomerDocuments(DOCUMENTS)
    expect(docs).toHaveLength(3)
    expect(docs[0]).toEqual({ id: '33715621', name: '141684432.pdf' })
    expect(docs.map((d: { id: string }) => d.id)).not.toContain('default')
  })
  it('is empty on anything else', () => {
    expect(parseCustomerDocuments('<html>login</html>')).toEqual([])
  })
})

describe('findUploadedDocId', () => {
  const before = parseCustomerDocuments(DOCUMENTS)
  const added = (id: string, name: string) => [...before, { id, name }]
  it('takes the row that appeared', () => {
    expect(findUploadedDocId(before, added('34700001', 'HD sign-off 1020258612.pdf'), 'HD sign-off 1020258612.pdf')).toBe('34700001')
  })
  it('matches on shape, not bytes — SF and a file picker disagree about spaces', () => {
    expect(findUploadedDocId(before, added('34700002', 'HD sign off.pdf'), 'HD sign off.pdf')).toBe('34700002')
  })
  it('takes a lone new row even under a name SF rewrote', () => {
    expect(findUploadedDocId(before, added('34700003', '1789445020_HDsignoff.pdf'), 'HD sign-off.pdf')).toBe('34700003')
  })
  it('falls back to the newest name match when nothing appeared (the list was already stale)', () => {
    expect(findUploadedDocId(before, before, 'Oson, Christopher waiver.pdf')).toBe('34351989')
  })
  it('is null when the file is simply not there — never a guess at someone else\'s document', () => {
    expect(findUploadedDocId(before, before, 'HD sign-off.pdf')).toBeNull()
  })
})

describe('attachSucceeded', () => {
  // The upload alone does nothing visible on the job; THIS response is the proof it landed.
  it('reads the confirmation and the job document id', () => {
    const body = '{"status":"ok","documentData":{"data":{"id":"34695322"},"jobDocId":"1344432368","jobDownloadDocId":"1344432368"},"jobUpdatedAt":"jSDM7"}'
    expect(attachSucceeded(body)).toEqual({ ok: true, jobDocId: '1344432368' })
  })
  it('fails loudly on anything else', () => {
    expect(attachSucceeded('{"status":"error"}').ok).toBe(false)
    expect(attachSucceeded('<html>login</html>').ok).toBe(false)
    expect(attachSucceeded('').ok).toBe(false)
  })
})

describe('fileKey', () => {
  it('flattens whitespace and case', () => {
    expect(fileKey('HD  Sign-Off A.PDF')).toBe('hd sign-off a.pdf')
  })
})
