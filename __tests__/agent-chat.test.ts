import { describe, it, expect } from 'vitest'
import { createSign, generateKeyPairSync } from 'crypto'
import { buildCard, decodeJwt, verifyEventToken, normalizePrivateKey, describePrivateKey } from '@/lib/agent/chat/google-chat'

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

describe('a real key, mangled every way an env store mangles one', () => {
  // The point of normalisation is not that the string looks right — it is that OpenSSL
  // signs with it. So generate a genuine key, break it, repair it, and sign.
  const PEM = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey as string
  const signs = (key: string) => { const s = createSign('RSA-SHA256'); s.update('payload'); return s.sign(key).length > 0 }

  it.each([
    ['untouched', (k: string) => k],
    ['literal backslash-n', (k: string) => k.replace(/\n/g, '\\n')],
    ['wrapped in quotes', (k: string) => `"${k.replace(/\n/g, '\\n')}"`],
    ['CRLF line endings', (k: string) => k.replace(/\n/g, '\r\n')],
    ['newlines collapsed to spaces', (k: string) => k.replace(/\n/g, ' ')],
    ['line breaks dropped entirely', (k: string) => k.replace(/\n/g, '')],
    ['re-wrapped at the wrong width', (k: string) => {
      const body = k.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '')
      return `-----BEGIN PRIVATE KEY-----\n${(body.match(/.{1,40}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----`
    }],
  ])('repairs a key %s', (_label, mangle) => {
    const repaired = normalizePrivateKey(mangle(PEM))
    expect(signs(repaired)).toBe(true)
    expect(repaired).toBe(normalizePrivateKey(repaired))   // idempotent
  })

  it('describes a truncated key without printing it', () => {
    const cut = PEM.slice(0, 400) + '\n-----END PRIVATE KEY-----\n'
    const d = describePrivateKey(normalizePrivateKey(cut))
    expect(d).toContain('truncated')
    expect(d).not.toContain(PEM.slice(60, 100))
  })
  it('says so when the markers are missing entirely', () => {
    expect(describePrivateKey('not a key at all')).toMatch(/no matching BEGIN\/END/)
  })
})
