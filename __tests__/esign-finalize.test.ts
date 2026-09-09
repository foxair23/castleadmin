import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { renderCompleted, inspectPdf } from '@/lib/esign/render'
import { templateByKey } from '@/lib/esign/templates'
import { readFileSync } from 'fs'
import { join } from 'path'

// The finished form: both signatures, both dates, the audit line — flattened, one page.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'))

async function deliveryBlank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([595, 842])
  p.drawText('HOMEDEPOT.COM ORDER', { x: 167, y: 772, size: 16, font })
  p.drawText('Lien Waiver – Proof of Delivery', { x: 180, y: 754, size: 14, font })
  p.drawText('Customer Signature', { x: 63, y: 607, size: 12, font })
  p.drawText('Date Completed', { x: 358, y: 607, size: 12, font })
  p.drawText('Installer’s Signature', { x: 66, y: 295, size: 12, font })
  p.drawText('Date', { x: 338, y: 295, size: 12, font })
  return doc.save()
}

describe('completed form', () => {
  it('carries both dates and the audit line with both names', async () => {
    const t = templateByKey('hd_com_lw_pod')!
    const done = await renderCompleted(await deliveryBlank(), t, {
      customer: { png: PNG, name: 'Chet Johnston', at: '2026-09-15T20:00:00Z', ip: '1.2.3.4' },
      tech: { png: PNG, name: 'Sam Tech', at: '2026-09-16T01:00:00Z', ip: '5.6.7.8' },
    })
    const insp = await inspectPdf(done)
    expect(insp.pageCount).toBe(1)
    expect(insp.firstPageText).toContain('9/15/2026')
    expect(insp.firstPageText).toContain('E-signed via Castle Garage Doors')
    expect(insp.firstPageText).toContain('Chet Johnston')
    expect(insp.firstPageText).toContain('Sam Tech')
    expect(insp.acroFields).toEqual([])
  })
  it('migration 128 seeds the office alert type and the upload queue', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/128_esign_finalize.sql'), 'utf8')
    expect(sql).toContain('sf_document_upload_queue')
    expect(sql).toContain("'esign_office_alert'")
    expect(sql).toMatch(/on conflict \(key\) do nothing/)
  })
})

describe('sf-docs queue routes are public for the extension', async () => {
  it('lives under /api/vendor-orders/', async () => {
    const { isPublicPath } = await import('@/proxy')
    expect(isPublicPath('/api/vendor-orders/sf-docs-queue')).toBe(true)
    expect(isPublicPath('/api/vendor-orders/sf-docs-callback')).toBe(true)
  })
})
