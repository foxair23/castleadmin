// The template registry: how to fill and sign each VERSION of a vendor's form.
//
// A blank form is identified by a fingerprint of its structure (page count, AcroForm field
// names, first-page text with digits stripped — see render.ts). Clopay has "a few versions"
// of the lien waiver, so the registry is keyed by fingerprint and ships EMPTY: a blank whose
// fingerprint is not here is held as `unrecognised_template` and listed on the Signatures →
// Templates page, where the layout is pinned by eye from a preview and then added HERE as a
// code change (reviewable, testable) — never guessed.
//
// Coordinates are PDF points with the origin at the page's bottom-left, as pdf-lib draws them.

export type FieldKind = 'text' | 'date' | 'signature' | 'customer_input'

/** Where a field's value comes from at render time. */
export type FieldSource =
  | 'customer_name' | 'address_line' | 'city' | 'state' | 'zip' | 'address_full'
  | 'po_numbers' | 'order_number' | 'install_date' | 'sf_job_number' | 'installer_name' | 'today'
  | 'customer_input'                                  // typed by the customer on the signing page
  | 'customer_signature' | 'customer_signed_name' | 'customer_signed_date'
  | 'tech_signature' | 'tech_signed_name' | 'tech_signed_date'

export interface Box { page: number; x: number; y: number; w: number; h: number }

export interface FieldSpec {
  key: string
  kind: FieldKind
  source: FieldSource
  /** AcroForm field name, when the form has real fields. Preferred over `box` when present. */
  acro?: string
  /** Where to draw when there is no AcroForm field (flat PDF) or for signatures/images. */
  box?: Box
  /** For customer_input: the label shown on the signing page. */
  label?: string
  required?: boolean
  /** Text size ceiling; shrinks to fit the box. */
  size?: number
}

export interface TemplateSpec {
  key: string
  vendor: string
  docType: string
  label: string
  /** Every blank-form version this layout applies to. */
  fingerprints: string[]
  fields: FieldSpec[]
}

export const TEMPLATES: TemplateSpec[] = [
  // Example of a pinned version (kept as documentation until the first real one lands):
  // {
  //   key: 'clopay_lw_2026a', vendor: 'clopay_hd', docType: 'lien_waiver', label: 'Clopay Lien Waiver (2026 form A)',
  //   fingerprints: ['0123456789abcdef'],
  //   fields: [
  //     { key: 'customer', kind: 'text', source: 'customer_name', box: { page: 0, x: 120, y: 640, w: 300, h: 14 } },
  //     { key: 'address',  kind: 'text', source: 'address_full', box: { page: 0, x: 120, y: 620, w: 400, h: 14 } },
  //     { key: 'po',       kind: 'text', source: 'po_numbers',   box: { page: 0, x: 420, y: 700, w: 150, h: 14 } },
  //     { key: 'cust_sig', kind: 'signature', source: 'customer_signature', box: { page: 0, x: 90, y: 120, w: 220, h: 50 } },
  //     { key: 'cust_dt',  kind: 'date', source: 'customer_signed_date',    box: { page: 0, x: 340, y: 120, w: 100, h: 14 } },
  //     { key: 'tech_sig', kind: 'signature', source: 'tech_signature',     box: { page: 0, x: 90, y: 60,  w: 220, h: 50 } },
  //     { key: 'tech_dt',  kind: 'date', source: 'tech_signed_date',        box: { page: 0, x: 340, y: 60,  w: 100, h: 14 } },
  //   ],
  // },
]

export function resolveTemplate(fingerprint: string | null | undefined): TemplateSpec | null {
  if (!fingerprint) return null
  return TEMPLATES.find(t => t.fingerprints.includes(fingerprint)) ?? null
}

export function templateByKey(key: string | null | undefined): TemplateSpec | null {
  if (!key) return null
  return TEMPLATES.find(t => t.key === key) ?? null
}
