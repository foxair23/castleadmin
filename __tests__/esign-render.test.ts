import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { inspectPdf, fingerprintPdf, renderPrepared, renderCompleted, renderOverlay } from '@/lib/esign/render'
import { buildPrefill } from '@/lib/esign/prefill'
import type { TemplateSpec } from '@/lib/esign/templates'

// Fixtures are built here with pdf-lib: an AcroForm blank and a flat one, each printed with an
// order number so the fingerprint test can show that number does not change the version.
async function flatBlank(orderNo: string, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792])
    p.drawText(`LIEN WAIVER — Order ${orderNo}`, { x: 50, y: 740, size: 14, font })
    p.drawText('Customer: ____________________   Signature: ____________________', { x: 50, y: 700, size: 10, font })
  }
  return doc.save()
}
async function acroBlank(orderNo: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([612, 792])
  p.drawText(`LIEN WAIVER — Order ${orderNo}`, { x: 50, y: 740, size: 14, font })
  const form = doc.getForm()
  form.createTextField('CustomerName').addToPage(p, { x: 120, y: 690, width: 250, height: 16 })
  form.createTextField('PO').addToPage(p, { x: 420, y: 690, width: 120, height: 16 })
  return doc.save()
}
// 1×1 red PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'))

const FLAT: TemplateSpec = {
  key: 't_flat', vendor: 'clopay_hd', docType: 'lien_waiver', label: 'flat', service: 'install', fingerprints: [],
  fields: [
    { key: 'name', kind: 'text', source: 'customer_name', box: { page: 0, x: 120, y: 695, w: 250, h: 14 } },
    { key: 'po', kind: 'text', source: 'po_numbers', box: { page: 0, x: 420, y: 695, w: 120, h: 14 } },
    { key: 'csig', kind: 'signature', source: 'customer_signature', box: { page: 0, x: 60, y: 120, w: 200, h: 50 } },
    { key: 'cdate', kind: 'date', source: 'customer_signed_date', box: { page: 0, x: 300, y: 120, w: 100, h: 14 } },
    { key: 'tsig', kind: 'signature', source: 'tech_signature', box: { page: 0, x: 60, y: 60, w: 200, h: 50 } },
    { key: 'notes', kind: 'customer_input', source: 'customer_input', label: 'Notes', box: { page: 0, x: 60, y: 300, w: 400, h: 14 } },
  ],
}
const ACRO: TemplateSpec = { ...FLAT, key: 't_acro', fields: [
  { key: 'name', kind: 'text', source: 'customer_name', acro: 'CustomerName' },
  { key: 'po', kind: 'text', source: 'po_numbers', acro: 'PO' },
  ...FLAT.fields.filter(f => f.kind === 'signature' || f.kind === 'date'),
] }

const ORDER = { external_id: '3865646', customer_name: 'Thien Huynh', customer_po: '46664198', street_address: '8129 Brock Ct', city: 'Lemon Grove', state_prov: 'CA', postal_code: '91945' }
const text = async (bytes: Uint8Array) => (await inspectPdf(bytes)).firstPageText

describe('fingerprintPdf', () => {
  it('is the same for two blanks of one version that differ only in the printed order number', async () => {
    const a = fingerprintPdf(await inspectPdf(await flatBlank('3865646')))
    const b = fingerprintPdf(await inspectPdf(await flatBlank('3867222')))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
  it('differs when the form itself differs — pages, fields, wording', async () => {
    const flat = fingerprintPdf(await inspectPdf(await flatBlank('1')))
    expect(fingerprintPdf(await inspectPdf(await flatBlank('1', 2)))).not.toBe(flat)
    expect(fingerprintPdf(await inspectPdf(await acroBlank('1')))).not.toBe(flat)
  })
  it('sees AcroForm fields by name', async () => {
    const insp = await inspectPdf(await acroBlank('1'))
    expect(insp.acroFields.map(f => f.name).sort()).toEqual(['CustomerName', 'PO'])
  })
})

describe('buildPrefill', () => {
  it('assembles the house, every door\'s PO, and the job', () => {
    const v = buildPrefill(ORDER, [{ ...ORDER, external_id: '3865647', customer_po: '46664199' }], { number: '1020259248', start_date: '2026-09-15' })
    expect(v.customer_name).toBe('Thien Huynh')
    expect(v.address_full).toBe('8129 Brock Ct, Lemon Grove, CA 91945')
    expect(v.po_numbers).toBe('46664198, 46664199')
    expect(v.install_date).toBe('09/15/2026')
    expect(v.sf_job_number).toBe('1020259248')
    expect(v.installer_name).toMatch(/Castle/)
  })
  it('leaves fields blank rather than writing "null"', () => {
    const v = buildPrefill({ ...ORDER, customer_name: null, street_address: null }, [], null)
    expect(v.customer_name).toBe('')
    expect(v.install_date).toBe('')
    expect(v.address_full).toBe('Lemon Grove, CA 91945')
  })
})

describe('renderPrepared', () => {
  it('fills AcroForm fields by name', async () => {
    const out = await renderPrepared(await acroBlank('1'), ACRO, buildPrefill(ORDER, [], null))
    const doc = await PDFDocument.load(out)
    expect(doc.getForm().getTextField('CustomerName').getText()).toBe('Thien Huynh')
    expect(doc.getForm().getTextField('PO').getText()).toBe('46664198')
  })
  it('draws into boxes on a flat PDF', async () => {
    const out = await renderPrepared(await flatBlank('1'), FLAT, buildPrefill(ORDER, [], null))
    const t = await text(out)
    expect(t).toContain('Thien Huynh')
    expect(t).toContain('46664198')
  })
  it('never writes a signature at the prepare stage', async () => {
    const before = (await flatBlank('1')).length
    const out = await renderPrepared(await flatBlank('1'), FLAT, {})
    expect(out.length).toBeLessThan(before + 4000)   // no image embedded
  })
})

describe('renderCompleted', () => {
  it('stamps both signatures, their dates, the customer\'s typed field, and an audit line, then flattens', async () => {
    const prepared = await renderPrepared(await acroBlank('1'), ACRO, buildPrefill(ORDER, [], null))
    const out = await renderCompleted(prepared, { ...ACRO, fields: [...ACRO.fields, FLAT.fields.find(f => f.key === 'notes')!] }, {
      customer: { png: PNG, name: 'Thien Huynh', at: '2026-09-15T20:00:00Z', ip: '1.2.3.4' },
      tech: { png: PNG, name: 'Sam Tech', at: '2026-09-15T21:00:00Z' },
      customerFields: { notes: 'Left gate open' },
    })
    const doc = await PDFDocument.load(out)
    expect(doc.getForm().getFields().length).toBe(0)                 // flattened
    const t = await text(out)
    expect(t).toContain('Thien Huynh')                                // prefill survived flattening
    expect(t).toContain('9/15/2026')                                  // signed date drawn
    expect(t).toContain('Left gate open')
    expect(t).toMatch(/E-signed via Castle/)
    expect(t).toMatch(/Technician: Sam Tech/)
    expect(out.length).toBeGreaterThan(prepared.length)              // images embedded
  })
  it('stamps only what has been signed so far', async () => {
    const prepared = await renderPrepared(await flatBlank('1'), FLAT, {})
    const out = await renderCompleted(prepared, FLAT, { customer: { png: PNG, name: 'Only Customer', at: '2026-09-15T20:00:00Z' } })
    const t = await text(out)
    expect(t).toMatch(/Customer: Only Customer/)
    expect(t).not.toMatch(/Technician:/)
  })
})

describe('renderOverlay', () => {
  it('labels every box and adds a ruler, without changing the page count', async () => {
    const out = await renderOverlay(await flatBlank('1'), FLAT)
    const insp = await inspectPdf(out)
    expect(insp.pageCount).toBe(1)
    for (const f of FLAT.fields) expect(insp.firstPageText).toContain(f.key)
  })
})

// The first real form version, pinned from a blank's text coordinates.
describe('template hd329_2021_06', () => {
  it('is recognised by the form number and revision Home Depot prints in the footer', async () => {
    const { resolveTemplate } = await import('@/lib/esign/templates')
    expect(resolveTemplate(null, 'Home Services Installation Customer Approval ... 329 Customer Approval (02 Jun. 21) Generated Date 05/21/2026')?.key).toBe('hd329_2021_06')
    expect(resolveTemplate('0000000000000000', 'some other form 330 Customer Approval (01 Jan. 24)')).toBeNull()
    expect(resolveTemplate(null, null)).toBeNull()
  })
  it('writes nothing Clopay already printed — signatures and their dates only', async () => {
    // Clopay fills the customer, address, PO, phones, service provider, and even the
    // "Additional PO(s)" line for a multi-door house. Every other box would overwrite them.
    const { templateByKey } = await import('@/lib/esign/templates')
    const t = templateByKey('hd329_2021_06')!
    const sources = t.fields.map(f => f.source).sort()
    expect(sources).toEqual(['customer_signature', 'customer_signed_date', 'tech_signature', 'tech_signed_date'])
    for (const f of t.fields) { expect(f.box).toBeTruthy(); expect(f.box!.page).toBe(0) }
  })
  it('fingerprints every copy of a stamped form alike, whoever it is made out to', async () => {
    const { versionStamp } = await import('@/lib/esign/render')
    const a = 'Home Services Installation Customer Approval VELASCO SERGIO 1334 O AVE ... 329 Customer Approval (02 Jun. 21) Generated Date 05/21/2026 Lead/PO# 58420903 v 113.1.1'
    const b = 'Home Services Installation Customer Approval JAGGARD CHRIS 1954 GREENFIELD DR ... 329 Customer Approval (02 Jun. 21) Generated Date 04/24/2026 Lead/PO# 48478131 v 113.1.1'
    expect(versionStamp(a)).toBe('329 customer approval (02 jun. 21) v 113.1.1')
    expect(versionStamp(a)).toBe(versionStamp(b))
    expect(versionStamp('LIEN WAIVER — Order 3865646 Customer: ____')).toBeNull()
    const base = { pageCount: 1, pageSizes: [{ w: 611, h: 843 }], acroFields: [] }
    expect(fingerprintPdf({ ...base, firstPageText: a })).toBe(fingerprintPdf({ ...base, firstPageText: b }))
    expect(fingerprintPdf({ ...base, firstPageText: a.replace('02 Jun. 21', '15 Mar. 24') })).not.toBe(fingerprintPdf({ ...base, firstPageText: a }))
  })
  it('lists only the OTHER doors under Additional PO(s)', () => {
    const v = buildPrefill(ORDER, [{ ...ORDER, external_id: '3865647', customer_po: '46664199' }], null)
    expect(v.additional_pos).toBe('46664199')
    expect(buildPrefill(ORDER, [], null).additional_pos).toBe('')
  })
})

// The second real form: homedepot.com's delivery waiver, which prints no version stamp.
describe('template hd_com_lw_pod', () => {
  it('is recognised by its title and knows it certifies a DELIVERY, not an install', async () => {
    const { resolveTemplate, templateByKey } = await import('@/lib/esign/templates')
    const t = resolveTemplate(null, 'HOMEDEPOT.COM ORDER Lien Waiver – Proof of Delivery Customer JOHNSTON, CHET ...')
    expect(t?.key).toBe('hd_com_lw_pod')
    expect(t?.service).toBe('delivery')
    expect(templateByKey('hd329_2021_06')?.service).toBe('install')
    // Either dash Clopay might emit.
    expect(resolveTemplate(null, 'Lien Waiver - Proof of Delivery')?.key).toBe('hd_com_lw_pod')
    expect(resolveTemplate('9b4c7db714746055')?.key).toBe('hd_com_lw_pod')
  })
  it('writes signatures and dates only, on page 1', async () => {
    const { templateByKey } = await import('@/lib/esign/templates')
    const t = templateByKey('hd_com_lw_pod')!
    expect(t.fields.map(f => f.source).sort()).toEqual(['customer_signature', 'customer_signed_date', 'tech_signature', 'tech_signed_date'])
    for (const f of t.fields) { expect(f.box).toBeTruthy(); expect(f.box!.page).toBe(0) }
  })
  it('fingerprints an unstamped form by its skeleton, so two customers\' blanks hash alike', async () => {
    const { formSkeleton } = await import('@/lib/esign/render')
    const boiler = [
      'HOMEDEPOT.COM ORDER', 'Lien Waiver – Proof of Delivery', 'Customer',
      'This document shall become effective to waive, relinquish, and forever release any right of the',
      'undersigned or by any laborer, mechanic, or materialman claiming through or under the',
      'Installer’s Signature', 'Date', 'Installer’s Company', 'CASTLE GARAGE INC',
    ]
    const a = { pageCount: 1, pageSizes: [{ w: 595, h: 842 }], acroFields: [], firstPageText: '',
      firstPageItems: [...boiler, 'JOHNSTON, CHET', '17202 AMARILLO RD', 'RAMONA, CA 92065', '5625331190', 'I accept the materials described in Proposal # 39975769 complete and satisfactory.'] }
    const b = { ...a, firstPageItems: [...boiler, 'VELASCO, SERGIO', '1334 O AVE', 'NATIONAL CITY, CA 91950', '6195551234', 'I accept the materials described in Proposal # 40011223 complete and satisfactory.'] }
    expect(formSkeleton(a)).toBe(formSkeleton(b))
    expect(formSkeleton(a)).not.toContain('johnston')
    expect(fingerprintPdf(a)).toBe(fingerprintPdf(b))
    // A different form (different boilerplate) hashes differently.
    const c = { ...a, firstPageItems: [...boiler.slice(0, 3), 'Some other sentence that is long enough to count as boilerplate here'] }
    expect(fingerprintPdf(c)).not.toBe(fingerprintPdf(a))
  })
})

// Forms that FLOW: a wrapped line pushes every label below it down, so boxes follow labels.
describe('anchored boxes', () => {
  async function labelled(labelY: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const p = doc.addPage([595, 842])
    p.drawText('Customer Signature', { x: 63, y: labelY, size: 12, font })
    p.drawText('Date Completed', { x: 358, y: labelY, size: 12, font })
    p.drawText('Date', { x: 338, y: 295, size: 12, font })
    return doc.save()
  }
  const SPEC: TemplateSpec = {
    key: 'anch', vendor: 'clopay_hd', docType: 'lien_waiver', label: 'anchored', service: 'delivery', fingerprints: [],
    fields: [
      { key: 'cust_sig', kind: 'signature', source: 'customer_signature', box: { page: 0, x: 66, y: 621, w: 168, h: 26 }, anchor: { text: /^Customer Signature$/, dx: 3, dy: 14 } },
      { key: 'cust_date', kind: 'date', source: 'customer_signed_date', box: { page: 0, x: 362, y: 622, w: 138, h: 12 }, anchor: { text: /^Date Completed$/, dx: 4, dy: 15 } },
      { key: 'tech_date', kind: 'date', source: 'tech_signed_date', box: { page: 0, x: 372, y: 288, w: 150, h: 12 }, anchor: { text: /^Date$/, dx: 34, dy: -7 } },
      { key: 'ghost', kind: 'date', source: 'tech_signed_date', box: { page: 0, x: 10, y: 10, w: 50, h: 12 }, anchor: { text: /^Nowhere$/, dx: 0, dy: 0 } },
    ],
  }
  it('follows the label when the page flows, and keeps the static box when the label is missing', async () => {
    const { anchorTemplate } = await import('@/lib/esign/render')
    const a = await anchorTemplate(await labelled(607), SPEC)
    const b = await anchorTemplate(await labelled(590), SPEC)
    const box = (t: TemplateSpec, k: string) => t.fields.find(f => f.key === k)!.box!
    expect(Math.round(box(a, 'cust_sig').y)).toBe(621)
    expect(Math.round(box(b, 'cust_sig').y)).toBe(604)
    expect(Math.round(box(b, 'cust_date').x)).toBe(362)
    // "Date" must not also match "Date Completed" — exactly one run.
    expect(Math.round(box(b, 'tech_date').y)).toBe(288)
    expect(box(b, 'ghost')).toEqual({ page: 0, x: 10, y: 10, w: 50, h: 12 })
  })
  it('places the date where the label moved to, end to end', async () => {
    const done = await renderCompleted(await labelled(590), SPEC, { customer: { png: PNG, name: 'C', at: '2026-09-15T20:00:00Z' } })
    const { getDocumentProxy } = await import('unpdf')
    const page = await (await getDocumentProxy(done)).getPage(1)
    const items = (await page.getTextContent()).items as Array<{ str: string; transform: number[] }>
    const date = items.find(i => i.str === '9/15/2026')!
    expect(Math.round(date.transform[5])).toBe(607)   // 590 + 15, then centred inside the 12pt box
  })
  it('the real delivery template anchors every box', async () => {
    const { templateByKey } = await import('@/lib/esign/templates')
    for (const f of templateByKey('hd_com_lw_pod')!.fields) expect(f.anchor).toBeTruthy()
  })
})
