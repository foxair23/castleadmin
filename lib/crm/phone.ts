// Service Fusion validates every phone it is given against the company's phone format —
// ten digits, no country code — and rejects the whole customer create with a 422 when one
// does not fit:
//
//   Contacts[0]: Phones[0]: Phone must contains 10 digits (number of digits of phone
//   format from company settings)
//
// We store phones in whatever form they arrived: E.164 from the SMS/lead pipeline
// ("+16195551234"), formatted from web forms ("(619) 555-1234"), or raw. All of them have
// to become "6195551234" on the way to SF, and anything that cannot is better left off
// the profile than allowed to sink the whole record.

/** The 10-digit form SF accepts, or null when the value cannot be made to fit. */
export function sfPhone(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '')
  if (d.length === 10) return d
  if (d.length === 11 && d.startsWith('1')) return d.slice(1)
  return null
}

/** The `phones` fragment of an SF contact — or nothing, when there is no usable phone. */
export function sfPhones(raw: string | null | undefined, type = 'Mobile'): { phones: Array<{ phone: string; type: string }> } | Record<string, never> {
  const p = sfPhone(raw)
  return p ? { phones: [{ phone: p, type }] } : {}
}
