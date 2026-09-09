import { createHash } from 'crypto'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { trimPdfPadding } from '@/lib/vendor-orders/ipo-ingest'
import type { TemplateSpec, Box } from './templates'

// Reading, fingerprinting, filling and signing PDFs. pdf-lib writes; unpdf reads text.
//
// Two kinds of blank exist in the wild: real AcroForm fields (fill by name) and flat drawings
// (draw text at coordinates). A template may mix both — a field with `acro` is filled when the
// form has it, otherwise its `box` is drawn on. Signatures are always drawn: a PNG fitted into
// its box, aspect kept.

export interface PdfInspection {
  pageCount: number
  pageSizes: Array<{ w: number; h: number }>
  acroFields: Array<{ name: string; type: string }>
  firstPageText: string
  /** The first page's text runs, as laid out — the boilerplate sentences a form is made of. */
  firstPageItems?: string[]
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const trimmed = trimPdfPadding(bytes)
  const doc = await PDFDocument.load(trimmed, { ignoreEncryption: true, updateMetadata: false })
  const pages = doc.getPages()
  let acroFields: Array<{ name: string; type: string }> = []
  try {
    acroFields = doc.getForm().getFields().map(f => ({ name: f.getName(), type: f.constructor.name.replace(/^PDF/, '') }))
  } catch { acroFields = [] }
  let firstPageText = ''
  let firstPageItems: string[] = []
  try {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(trimmed)
    const { text } = await extractText(pdf, { mergePages: false })
    firstPageText = Array.isArray(text) ? String(text[0] ?? '') : String(text ?? '')
    const page = await pdf.getPage(1)
    const tc = await page.getTextContent()
    firstPageItems = (tc.items as Array<{ str?: string }>).map(i => (i.str ?? '').trim()).filter(Boolean)
  } catch { /* text is best-effort */ }
  return { pageCount: pages.length, pageSizes: pages.map(p => ({ w: p.getWidth(), h: p.getHeight() })), acroFields, firstPageText, firstPageItems }
}

/** The form's own version stamp, when it prints one: Home Depot's forms carry a form number
 *  and revision in the footer ("329 Customer Approval (02 Jun. 21)") and a generator version
 *  ("v 113.1.1"). Null when nothing of the kind is present. */
export function versionStamp(firstPageText: string): string | null {
  const t = firstPageText.replace(/\s+/g, ' ')
  const form = t.match(/\b\d{3}\s+[A-Za-z][A-Za-z ]{2,40}\(\d{1,2}\s*[A-Za-z]{3}\.?\s*\d{2,4}\)/)
  const gen = t.match(/\bv\s*\d+(?:\.\d+)+\b/)
  if (!form && !gen) return null
  return [form?.[0], gen?.[0]].filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ')
}

/** The text a form is MADE OF, as opposed to what was typed into it: its long runs —
 *  sentences of boilerplate and multi-word labels — with digits stripped. Names, addresses,
 *  phone numbers and dates are short and drop out, so two blanks of one form made out to
 *  different customers keep the same skeleton. */
export function formSkeleton(insp: PdfInspection): string {
  const items = insp.firstPageItems?.length ? insp.firstPageItems : insp.firstPageText.split(/\n+/)
  return items
    .map(s => s.toLowerCase().replace(/\d+/g, '').replace(/\s+/g, ' ').trim())
    .filter(s => s.length >= 25)
    .sort()
    .join('|')
    .slice(0, 6000)
}

/** Identifies a form VERSION, not a copy of it. A form that prints its version stamp is
 *  identified by that — every blank of one revision hashes alike no matter whose name is
 *  on it. Otherwise its skeleton is hashed (page count, sizes, field names, long text runs
 *  with digits stripped), which also survives a change of customer. */
export function fingerprintPdf(insp: PdfInspection): string {
  const fields = insp.acroFields.map(f => f.name).sort().join(',')
  const sizes = insp.pageSizes.map(s => `${Math.round(s.w)}x${Math.round(s.h)}`).join(',')
  const text = versionStamp(insp.firstPageText) ?? formSkeleton(insp)
  return createHash('sha256').update(`${insp.pageCount}|${sizes}|${fields}|${text}`).digest('hex').slice(0, 16)
}

/** Text that fits: shrink from `max` until the string fits the box width, floor at 6pt. */
function fitSize(font: PDFFont, text: string, width: number, max: number): number {
  let size = max
  while (size > 6 && font.widthOfTextAtSize(text, size) > width) size -= 0.5
  return size
}

function drawTextInBox(page: PDFPage, font: PDFFont, text: string, box: Box, max = 10) {
  const size = fitSize(font, text, box.w, Math.min(max, box.h))
  page.drawText(text, { x: box.x + 1, y: box.y + (box.h - size) / 2 + 1, size, font, color: rgb(0, 0, 0) })
}

export type Values = Partial<Record<string, string>>

/** Fill every text/date field the values cover. Fields without a value are left blank. */
export async function renderPrepared(bytes: Uint8Array, template: TemplateSpec, values: Values): Promise<Uint8Array> {
  const doc = await PDFDocument.load(trimPdfPadding(bytes), { ignoreEncryption: true, updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const form = safeForm(doc)
  const pages = doc.getPages()
  for (const f of template.fields) {
    if (f.kind === 'signature' || f.kind === 'customer_input') continue
    const v = values[f.source]
    if (!v) continue
    if (f.acro && form) {
      const tf = form.getFieldMaybe(f.acro)
      if (tf && 'setText' in tf) { (tf as { setText: (s: string) => void }).setText(v); continue }
    }
    if (f.box && pages[f.box.page]) drawTextInBox(pages[f.box.page], font, v, f.box, f.size)
  }
  if (form) { try { form.updateFieldAppearances(font) } catch { /* no fields */ } }
  return doc.save({ useObjectStreams: false })
}

export interface SignatureInput { png: Uint8Array; name: string; at: string; ip?: string | null }
export interface CompletionInput {
  customer?: SignatureInput
  tech?: SignatureInput
  /** Free-text the customer typed on the signing page, by field key. */
  customerFields?: Values
  values?: Values
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })
const fmtStamp = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })

/** Stamp the signatures (and their dates/names, and any customer-typed fields) onto the
 *  prepared PDF, flatten any form fields, and add a small audit line to the last page. */
export async function renderCompleted(prepared: Uint8Array, template: TemplateSpec, input: CompletionInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(prepared, { ignoreEncryption: true, updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const form = safeForm(doc)
  const pages = doc.getPages()

  const derived: Values = { ...(input.values ?? {}) }
  if (input.customer) { derived.customer_signed_name = input.customer.name; derived.customer_signed_date = fmtDate(input.customer.at) }
  if (input.tech) { derived.tech_signed_name = input.tech.name; derived.tech_signed_date = fmtDate(input.tech.at) }

  for (const f of template.fields) {
    const page = f.box ? pages[f.box.page] : undefined
    if (f.kind === 'signature') {
      const sig = f.source === 'customer_signature' ? input.customer : f.source === 'tech_signature' ? input.tech : undefined
      if (!sig || !f.box || !page) continue
      const img = await doc.embedPng(sig.png)
      const scale = Math.min(f.box.w / img.width, f.box.h / img.height)
      const w = img.width * scale, h = img.height * scale
      page.drawImage(img, { x: f.box.x + (f.box.w - w) / 2, y: f.box.y + (f.box.h - h) / 2, width: w, height: h })
      continue
    }
    const v = f.kind === 'customer_input' ? input.customerFields?.[f.key] : derived[f.source]
    if (!v) continue
    if (f.acro && form) {
      const tf = form.getFieldMaybe(f.acro)
      if (tf && 'setText' in tf) { (tf as { setText: (s: string) => void }).setText(v); continue }
    }
    if (f.box && page) drawTextInBox(page, font, v, f.box, f.size)
  }

  if (form) {
    try { form.updateFieldAppearances(font); form.flatten() } catch { /* nothing to flatten */ }
  }

  // Audit line: who signed, when, from where. Small, grey, bottom of the last page.
  const last = pages[pages.length - 1]
  const parts: string[] = []
  if (input.customer) parts.push(`Customer: ${input.customer.name} · ${fmtStamp(input.customer.at)} PT${input.customer.ip ? ` · ${input.customer.ip}` : ''}`)
  if (input.tech) parts.push(`Technician: ${input.tech.name} · ${fmtStamp(input.tech.at)} PT${input.tech.ip ? ` · ${input.tech.ip}` : ''}`)
  if (parts.length) {
    const line = `E-signed via Castle Garage Doors & Gates — ${parts.join('  |  ')}`
    last.drawText(line, { x: 24, y: 14, size: fitSize(font, line, last.getWidth() - 48, 7), font, color: rgb(0.45, 0.45, 0.45) })
  }
  return doc.save({ useObjectStreams: false })
}

/** The prepared PDF with every template box outlined and labelled, for pinning a layout by
 *  eye on the Templates page. Also works with an unregistered form: boxes come from `spec`,
 *  which may be a candidate layout being tried out. */
export async function renderOverlay(bytes: Uint8Array, spec: Pick<TemplateSpec, 'fields'>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(trimPdfPadding(bytes), { ignoreEncryption: true, updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  const pages = doc.getPages()
  for (const f of spec.fields) {
    if (!f.box || !pages[f.box.page]) continue
    const page = pages[f.box.page]
    page.drawRectangle({ x: f.box.x, y: f.box.y, width: f.box.w, height: f.box.h, borderColor: rgb(0.85, 0.1, 0.1), borderWidth: 1 })
    page.drawText(f.key, { x: f.box.x + 2, y: f.box.y + f.box.h + 2, size: 7, font, color: rgb(0.85, 0.1, 0.1) })
  }
  // A coordinate ruler on page 1 so a box can be placed from the preview alone.
  const p0 = pages[0]
  for (let x = 0; x < p0.getWidth(); x += 50) p0.drawText(String(x), { x, y: 4, size: 5, font, color: rgb(0.3, 0.3, 0.9) })
  for (let y = 0; y < p0.getHeight(); y += 50) p0.drawText(String(y), { x: 2, y, size: 5, font, color: rgb(0.3, 0.3, 0.9) })
  return doc.save({ useObjectStreams: false })
}

function safeForm(doc: PDFDocument) {
  try { const f = doc.getForm(); return f.getFields().length ? f : null } catch { return null }
}
