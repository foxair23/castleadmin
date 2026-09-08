import { describe, it, expect } from 'vitest'
import { buildCard, decodeJwt, verifyEventToken } from '@/lib/agent/chat/google-chat'

describe('buildCard', () => {
  it('renders paragraphs as decorated text and buttons as native widgets', () => {
    const c = buildCard('ask-1', {
      header: 'Cassie needs a hand', subheader: 'Jane (Home Depot)',
      paragraphs: [{ label: 'They asked', text: 'Ship date for PO 1' }, { text: 'Reply in thread' }],
      buttons: [{ text: 'Approve', fn: 'approve', params: { ask: 'a1', reply: 'r1' }, primary: true }, { text: 'Open', fn: 'open', url: 'https://x' }],
    }) as { cardId: string; card: { header: { title: string }; sections: Array<{ widgets: Array<Record<string, unknown>> }> } }
    expect(c.cardId).toBe('ask-1')
    expect(c.card.header.title).toBe('Cassie needs a hand')
    const w = c.card.sections[0].widgets
    expect(w[0]).toEqual({ decoratedText: { topLabel: 'They asked', text: 'Ship date for PO 1', wrapText: true } })
    const buttons = (w[2] as { buttonList: { buttons: Array<Record<string, unknown>> } }).buttonList.buttons
    expect(buttons[0]).toMatchObject({ text: 'Approve', type: 'FILLED', onClick: { action: { function: 'approve', parameters: [{ key: 'ask', value: 'a1' }, { key: 'reply', value: 'r1' }] } } })
    expect(buttons[1]).toMatchObject({ text: 'Open', onClick: { openLink: { url: 'https://x' } } })
  })
})

describe('event token verification', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  it('rejects missing, malformed, wrong-issuer, wrong-audience and expired tokens before touching the network', async () => {
    expect(await verifyEventToken(null, '123')).toMatchObject({ ok: false, reason: 'no bearer token' })
    expect(await verifyEventToken('Bearer nope', '123')).toMatchObject({ ok: false, reason: 'malformed token' })
    const mk = (p: Record<string, unknown>, h: Record<string, unknown> = { alg: 'RS256', kid: 'k' }) => `Bearer ${b64(h)}.${b64(p)}.sig`
    expect(await verifyEventToken(mk({ iss: 'evil', aud: '123', exp: 9e9 }), '123')).toMatchObject({ ok: false, reason: /issuer/ })
    expect(await verifyEventToken(mk({ iss: 'chat@system.gserviceaccount.com', aud: '999', exp: 9e9 }), '123')).toMatchObject({ ok: false, reason: 'audience mismatch' })
    expect(await verifyEventToken(mk({ iss: 'chat@system.gserviceaccount.com', aud: '123', exp: 1 }), '123')).toMatchObject({ ok: false, reason: 'expired' })
    expect(await verifyEventToken(mk({ iss: 'chat@system.gserviceaccount.com', aud: '123', exp: 9e9 }, { alg: 'HS256' }), '123')).toMatchObject({ ok: false, reason: /alg/ })
  })
  it('decodeJwt reads header and payload', () => {
    const t = `${b64({ alg: 'RS256', kid: 'abc' })}.${b64({ iss: 'x', aud: 'y' })}.zzz`
    expect(decodeJwt(t)).toEqual({ header: { alg: 'RS256', kid: 'abc' }, payload: { iss: 'x', aud: 'y' } })
    expect(decodeJwt('a.b')).toBeNull()
  })
})
