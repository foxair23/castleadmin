import { describe, it, expect } from 'vitest'

// Which number e-sign texts a technician's signing link to. The Castle profile wins over
// the Service Fusion tech record: sf_techs.phone_1/phone_2 is not a field anyone here
// curates for this, so a stale one sent a customer's form to the wrong person and a missing
// one sent nothing at all. SF stays as a fallback so a tech without a mobile set yet is
// still reachable; once every technician has one, the fallback can go.
const pickPhone = (profileMobile: string | null, phone1: string | null, phone2: string | null) =>
  (profileMobile ?? '').trim() || phone1 || phone2 || null

describe('which number a tech is texted on', () => {
  it('prefers the mobile set in Manage Technicians', () => {
    expect(pickPhone('6195550134', '8585551111', null)).toBe('6195550134')
  })
  it('falls back to Service Fusion when no mobile is set yet', () => {
    expect(pickPhone(null, '8585551111', null)).toBe('8585551111')
    expect(pickPhone('', '8585551111', '7605552222')).toBe('8585551111')
    expect(pickPhone('   ', null, '7605552222')).toBe('7605552222')
  })
  it('is null when nobody has a number, which raises the office alert', () => {
    expect(pickPhone(null, null, null)).toBeNull()
    expect(pickPhone('  ', null, null)).toBeNull()
  })
})

// What the field accepts. Blank clears it; anything else must look like a US mobile, or a
// typo becomes a link texted into the void with nothing to say it failed.
const validMobile = (raw: string) => {
  const t = raw.trim()
  if (!t) return true
  const d = t.replace(/\D/g, '')
  return d.length === 10 || (d.length === 11 && d.startsWith('1'))
}

describe('mobile number validation', () => {
  it('takes the shapes people actually type', () => {
    expect(validMobile('6195550134')).toBe(true)
    expect(validMobile('(619) 555-0134')).toBe(true)
    expect(validMobile('619-555-0134')).toBe(true)
    expect(validMobile('+1 619 555 0134')).toBe(true)
  })
  it('allows blank, which clears it', () => {
    expect(validMobile('')).toBe(true)
    expect(validMobile('   ')).toBe(true)
  })
  it('rejects a number that cannot be texted', () => {
    expect(validMobile('555-0134')).toBe(false)        // too short
    expect(validMobile('26195550134')).toBe(false)     // 11 digits not starting with 1
    expect(validMobile('619555013456')).toBe(false)    // too long
  })
})
