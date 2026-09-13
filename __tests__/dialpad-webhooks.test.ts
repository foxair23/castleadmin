import { describe, it, expect } from 'vitest'
import { sameHookUrl, isStaleHook } from '@/lib/dialpad/client'

describe('Dialpad webhook addresses', () => {
  const current = 'https://hq.castlegarage.com/api/dialpad/sms-webhook'
  it('treats the same host and path as the same address', () => {
    expect(sameHookUrl('https://hq.castlegarage.com/api/dialpad/sms-webhook/', current)).toBe(true)
    expect(sameHookUrl('HTTPS://HQ.castlegarage.com/api/dialpad/sms-webhook', current)).toBe(true)
  })
  it('flags the old domain and other paths as stale', () => {
    expect(isStaleHook('https://hq.castlegaragedoors.com/api/dialpad/sms-webhook', current)).toBe(true)
    expect(isStaleHook('https://castleadmin.vercel.app/api/dialpad/sms-webhook', current)).toBe(true)
    expect(isStaleHook('https://hq.castlegarage.com/api/other', current)).toBe(true)
    expect(isStaleHook('', current)).toBe(true)
    expect(isStaleHook(current, current)).toBe(false)
  })
})
