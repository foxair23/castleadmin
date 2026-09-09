import type { Values } from './render'

// What goes on the blank before anyone signs: the house, the order, the job. Every value is
// plain text in the form the paperwork expects; a missing source simply leaves its field blank.

export interface PrefillOrder {
  external_id: string | null; customer_name: string | null; customer_po: string | null
  street_address: string | null; city: string | null; state_prov: string | null; postal_code: string | null
}
export interface PrefillJob { number: string | null; start_date: string | null }

export const INSTALLER_NAME = 'Castle Garage Doors & Gates'

const mdy = (iso: string | null | undefined) => {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ''
}

export function buildPrefill(root: PrefillOrder, doors: PrefillOrder[], job: PrefillJob | null, today = new Date()): Values {
  const pos = [...new Set([root, ...doors].map(d => d.customer_po || d.external_id).filter(Boolean) as string[])]
  const addressLine = root.street_address ?? ''
  const cityStateZip = [root.city, [root.state_prov, root.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return {
    customer_name: root.customer_name ?? '',
    address_line: addressLine,
    city: root.city ?? '',
    state: root.state_prov ?? '',
    zip: root.postal_code ?? '',
    address_full: [addressLine, cityStateZip].filter(Boolean).join(', '),
    po_numbers: pos.join(', '),
    order_number: root.external_id ?? '',
    install_date: mdy(job?.start_date),
    sf_job_number: job?.number ?? '',
    installer_name: INSTALLER_NAME,
    today: today.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }),
  }
}
