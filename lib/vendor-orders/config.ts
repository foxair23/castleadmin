// Per-vendor adapters. Each portal maps its scraped order onto our shared
// vendor_orders shape and (Phase 2) onto the SF job it should create. Adding a
// new vendor = add an entry here + its content-script scraper; everything
// downstream (log, status page, SF job creation) is shared.

export interface VendorConfig {
  /** Stable key stored in vendor_orders.vendor. */
  key: string
  /** Human label for the admin UI. */
  label: string
  /** SF job Source these orders get created under (Phase 2). */
  sfJobSource: string
  /**
   * SF custom fields to set on the created job (Phase 2). Keyed by the SF custom
   * field's display name; value is the vendor_orders column to pull from.
   */
  sfCustomFields: Array<{ sfFieldName: string; from: keyof VendorOrderFields }>
  /** Service line items added to every created job (Phase 2), by name. */
  sfServiceLines?: Array<{ name: string; quantity?: number }>
}

/** The columns a scraper can populate (subset of vendor_orders). */
export interface VendorOrderFields {
  external_id: string
  status: string | null
  next_step: string | null
  order_type: string | null
  customer_name: string | null
  customer_po: string | null
  store_number: string | null
  order_date: string | null
  schedule_date: string | null
  street_address: string | null
  city: string | null
  state_prov: string | null
  postal_code: string | null
  phone: string | null
  email: string | null
  scope: string | null
}

export const VENDORS: Record<string, VendorConfig> = {
  genie_thd: {
    key: 'genie_thd',
    label: 'Genie — Home Depot',
    // Per business rule: jobs from this vendor are Source = "Genie" in SF.
    sfJobSource: 'Genie',
    sfCustomFields: [
      { sfFieldName: 'Home Depot Order #', from: 'external_id' },
      { sfFieldName: 'Home Depot Store #', from: 'store_number' },
    ],
    // Every Genie job gets this service line added.
    sfServiceLines: [{ name: 'Overhead Door Motor Install', quantity: 1 }],
  },
}

export function getVendor(key: string): VendorConfig | null {
  return VENDORS[key] ?? null
}
