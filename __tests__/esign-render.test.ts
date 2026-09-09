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
  key: 't_flat', vendor: 'clopay_hd', docType: 'lien_waiver', label: 'flat', fingerprints: [],
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
