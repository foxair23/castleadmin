// Client calls for the Genie self-scheduler. Availability is shared with the
// main scheduler (same capacity rules); lookup + book are Genie-specific.
export { fetchAvailability } from '@/app/embed/scheduler/lib/api'

export interface GenieMatch {
  order_id: string
  order_number: string
  sf_job_number: string | null
  customer_name: string | null
  street_address: string | null
  city: string | null
  state_prov: string | null
  postal_code: string | null
  scope: string | null
  already_scheduled: { date: string; window_start: string | null; window_end: string | null } | null
}

export interface GenieAnswers {
  door_type?: 'metal_sectional' | 'one_piece_wood'
  door_over_7ft?: boolean
  clearance_10ft?: boolean
  adult_present?: boolean
  outlet_within_3ft?: 'yes' | 'no'
  notes?: string
}

export async function lookupOrder(
  input: { phone?: string; email?: string; last_name?: string; postal_code?: string },
  widgetKey: string,
): Promise<{ ok: boolean; matches: GenieMatch[]; error?: string }> {
  try {
    const res = await fetch('/api/genie-scheduler/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Castle-Widget-Key': widgetKey },
      body: JSON.stringify(input),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, matches: [], error: (data as { error?: string }).error ?? 'Lookup failed.' }
    return { ok: true, matches: (data as { matches: GenieMatch[] }).matches ?? [] }
  } catch {
    return { ok: false, matches: [], error: 'Network error — please try again.' }
  }
}

export interface GenieBookingInput {
  order_id: string
  appointment_date: string
  window_start?: string   // omitted in day-only mode
  window_end?: string
  contact_phone?: string
  contact_email?: string
  answers: GenieAnswers
}

export interface GenieBookingResult {
  ok: boolean
  sf_synced?: boolean
  order_number?: string
  sf_job_number?: string | null
  error?: string
}

export async function submitGenieBooking(input: GenieBookingInput, widgetKey: string): Promise<GenieBookingResult> {
  try {
    const res = await fetch('/api/genie-scheduler/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Castle-Widget-Key': widgetKey },
      body: JSON.stringify(input),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: (data as { error?: string }).error ?? 'Could not schedule.' }
    return data as GenieBookingResult
  } catch {
    return { ok: false, error: 'Network error — please try again.' }
  }
}
