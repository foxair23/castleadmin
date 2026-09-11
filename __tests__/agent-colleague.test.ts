import { describe, it, expect } from 'vitest'
import { mergeSettings } from '@/lib/agent/settings'

describe('colleague mode setting', () => {
  it('is on by default and editable', () => {
    expect(mergeSettings({}).chat_colleague_enabled).toBe(true)
    expect(mergeSettings({ chat_colleague_enabled: false }).chat_colleague_enabled).toBe(false)
  })
})
