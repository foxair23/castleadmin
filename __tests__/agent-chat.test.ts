import { describe, it, expect } from 'vitest'
import { buildCard, decodeJwt, verifyEventToken, normalizePrivateKey } from '@/lib/agent/chat/google-chat'

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
  const AUD = ['123', 'https://hq.castlegarage.com/api/cassie/chat/events']
  const mk = (p: Record<string, unknown>, h: Record<string, unknown> = { alg: 'RS256', kid: 'k' }) => `Bearer ${b64(h)}.${b64(p)}.sig`
  it('rejects missing, malformed, wrong-issuer, wrong-audience and expired tokens before touching the network', async () => {
    expect(await verifyEventToken(null, AUD)).toMatchObject({ ok: false, reason: 'no bearer token' })
    expect(await verifyEventToken('Bearer nope', AUD)).toMatchObject({ ok: false, reason: 'malformed token' })
    expect(await verifyEventToken(mk({ iss: 'evil', aud: '123', exp: 9e9 }), AUD)).toMatchObject({ ok: false, reason: /issuer/ })
    // An add-on service agent from ANOTHER project is not ours.
    expect(await verifyEventToken(mk({ iss: 'service-999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com', aud: '123', exp: 9e9 }), AUD)).toMatchObject({ ok: false, reason: /issuer/ })
    expect(await verifyEventToken(mk({ iss: 'chat@system.gserviceaccount.com', aud: '999', exp: 9e9 }), AUD)).toMatchObject({ ok: false, reason: /audience/ })
    expect(await verifyEventToken(mk({ iss: 'chat@system.gserviceaccount.com', aud: '123', exp: 1 }), AUD)).toMatchObject({ ok: false, reason: 'expired' })
    expect(await verifyEventToken(mk({ iss: 'chat@system.gserviceaccount.com', aud: '123', exp: 9e9 }, { alg: 'HS256' }), AUD)).toMatchObject({ ok: false, reason: /alg/ })
  })
  it('accepts both issuers: classic Chat, and this project\'s add-on service agent', async () => {
    const ISS = ['chat@system.gserviceaccount.com', 'service-1026096616480@gcp-sa-gsuiteaddons.iam.gserviceaccount.com']
    for (const iss of ISS) {
      const r = await verifyEventToken(mk({ iss, aud: '123', exp: 9e9 }), AUD, ISS)
      expect((r as { reason: string }).reason).not.toMatch(/issuer/)
    }
  })
  it('accepts either audience Google may send — project number or the endpoint URL', async () => {
    // Both get past the audience check and fail later, at the signature: proof the
    // audience itself was accepted. Whichever way the Chat app is configured, it works.
    for (const aud of AUD) {
      const r = await verifyEventToken(mk({ iss: 'chat@system.gserviceaccount.com', aud, exp: 9e9 }), AUD)
      expect(r.ok).toBe(false)
      expect((r as { reason: string }).reason).not.toMatch(/audience/)
    }
  })
  it('decodeJwt reads header and payload', () => {
    const t = `${b64({ alg: 'RS256', kid: 'abc' })}.${b64({ iss: 'x', aud: 'y' })}.zzz`
    expect(decodeJwt(t)).toEqual({ header: { alg: 'RS256', kid: 'abc' }, payload: { iss: 'x', aud: 'y' } })
    expect(decodeJwt('a.b')).toBeNull()
  })
})

describe('service-account private key normalisation', () => {
  const REAL = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQ\n-----END PRIVATE KEY-----\n'
  it('repairs literal backslash-n, the usual env-store corruption', () => {
    const mangled = REAL.replace(/\n/g, '\\n')
    expect(normalizePrivateKey(mangled)).toBe(REAL)
  })
  it('strips wrapping quotes some stores add', () => {
    expect(normalizePrivateKey(`"${REAL.replace(/\n/g, '\\n')}"`)).toBe(REAL)
    expect(normalizePrivateKey(`'${REAL.replace(/\n/g, '\\n')}'`)).toBe(REAL)
  })
  it('leaves an already-valid key alone, and always ends with a newline', () => {
    expect(normalizePrivateKey(REAL)).toBe(REAL)
    expect(normalizePrivateKey(REAL.trimEnd())).toBe(REAL)
  })
  it('normalises CRLF', () => {
    expect(normalizePrivateKey(REAL.replace(/\n/g, '\r\n'))).toBe(REAL)
  })
})
