import { describe, it, expect } from 'vitest'
import { createPrivateKey, createSign, generateKeyPairSync } from 'crypto'
import { buildCard, decodeJwt, verifyEventToken, allowedIssuers, normalizePrivateKey, describePrivateKey, checkKeyFile } from '@/lib/agent/chat/google-chat'

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
  it("accepts Google's OIDC issuer, which is what a Workspace add-on actually sends", () => {
    const prev = process.env.GOOGLE_CHAT_PROJECT_NUMBER
    process.env.GOOGLE_CHAT_PROJECT_NUMBER = '123'
    try {
      expect(allowedIssuers()).toContain('https://accounts.google.com')
      delete process.env.GOOGLE_CHAT_PROJECT_NUMBER
      expect(allowedIssuers()).toContain('https://accounts.google.com')
    } finally { if (prev === undefined) delete process.env.GOOGLE_CHAT_PROJECT_NUMBER; else process.env.GOOGLE_CHAT_PROJECT_NUMBER = prev }
  })
  it('refuses an OIDC token that speaks for somebody else\'s project', async () => {
    // accounts.google.com signs for every Google identity, so the audience alone is not a
    // gate: another project's app aimed at our URL is signed by ITS service agent.
    const ISS = ['chat@system.gserviceaccount.com', 'service-1026096616480@gcp-sa-gsuiteaddons.iam.gserviceaccount.com', 'https://accounts.google.com']
    const r = await verifyEventToken(mk({ iss: 'https://accounts.google.com', aud: '123', exp: 9e9, email: 'service-999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com' }), AUD, ISS)
    expect(r).toMatchObject({ ok: false, reason: /token subject .* is not one of/ })
  })
  it('lets our own project past the subject check', async () => {
    const ISS = ['chat@system.gserviceaccount.com', 'https://accounts.google.com']
    const r = await verifyEventToken(mk({ iss: 'https://accounts.google.com', aud: '123', exp: 9e9, email: 'chat@system.gserviceaccount.com' }), AUD, ISS)
    expect((r as { reason: string }).reason).not.toMatch(/issuer|token subject/)
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
    ['base64 rewritten URL-safe', (k: string) => k.replace(/\+/g, '-').replace(/\//g, '_')],
    ['re-wrapped at the wrong width', (k: string) => {
      const body = k.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '')
      return `-----BEGIN PRIVATE KEY-----\n${(body.match(/.{1,40}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----`
    }],
  ])('repairs a key %s', (_label, mangle) => {
    const repaired = normalizePrivateKey(mangle(PEM))
    expect(signs(repaired)).toBe(true)
    expect(repaired).toBe(normalizePrivateKey(repaired))   // idempotent
  })

  it('relabels a PKCS#1 key that arrived under a PKCS#8 label', () => {
    const pkcs1 = createPrivateKey(PEM).export({ type: 'pkcs1', format: 'pem' }).toString()
    const mislabelled = pkcs1.replace(/RSA PRIVATE KEY/g, 'PRIVATE KEY')
    const repaired = normalizePrivateKey(mislabelled)
    expect(repaired).toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(signs(repaired)).toBe(true)
  })

  describe('describePrivateKey reads the raw value, and never prints it', () => {
    const secret = PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '').slice(80, 140)
    it('reports a healthy key as PKCS#8 of the expected size', () => {
      const d = describePrivateKey(PEM)
      expect(d).toContain('label PRIVATE KEY')
      expect(d).toMatch(/\d+ decoded bytes/)
      expect(d).not.toContain('corrupt')
      expect(d).not.toContain(secret)
    })
    it('counts what the repair had to throw away', () => {
      expect(describePrivateKey(PEM.replace(/\+/g, '#'))).toMatch(/characters outside the base64 alphabet/)
    })
    it('names missing bytes when the body is cut short', () => {
      const body = PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '')
      const cut = `-----BEGIN PRIVATE KEY-----\n${body.slice(0, 800)}\n-----END PRIVATE KEY-----\n`
      expect(describePrivateKey(cut)).toMatch(/are missing/)
    })
    it('says so when the bytes are neither PKCS#8 nor PKCS#1', () => {
      const junk = Buffer.from('not a key, just some bytes that base64 cleanly').toString('base64')
      expect(describePrivateKey(`-----BEGIN PRIVATE KEY-----\n${junk}\n-----END PRIVATE KEY-----\n`)).toMatch(/not an ASN.1 SEQUENCE|corrupt/)
    })
    it('distinguishes corrupt key material from a corrupt wrapper', () => {
      // A PKCS#8 header — right SEQUENCE, right declared length, right RSA OID — wrapped
      // around bytes that are not a key. Every envelope check passes; only OpenSSL knows.
      const good = Buffer.from(PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, ''), 'base64')
      const der = Buffer.concat([good.subarray(0, 40), Buffer.alloc(good.length - 40, 0x41)])
      const d = describePrivateKey(`-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`)
      expect(d).not.toMatch(/outside the base64 alphabet|are missing|are extra/)
      expect(d).toMatch(/key material that is NOT intact/)
    })
    it('says nothing about the material when the key is healthy', () => {
      expect(describePrivateKey(PEM)).not.toMatch(/NOT intact/)
    })
    it('says so when there are no markers at all', () => {
      expect(describePrivateKey('not a key at all')).toMatch(/not a PEM key at all/)
    })
  })
})

describe('checkKeyFile', () => {
  const PEM = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey as string
  const file = JSON.stringify({ client_email: 'cassie@p.iam.gserviceaccount.com', private_key: PEM })

  it('signs a good key file and names the account', () => {
    const r = checkKeyFile(file)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('cassie@p.iam.gserviceaccount.com')
  })
  it('accepts a bare PEM as well as a key file', () => {
    expect(checkKeyFile(PEM).ok).toBe(true)
  })
  it('blames the file, not the environment, when the key cannot sign', () => {
    const good = Buffer.from(PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, ''), 'base64')
    const der = Buffer.concat([good.subarray(0, 40), Buffer.alloc(good.length - 40, 0x41)])
    const broken = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`
    const r = checkKeyFile(JSON.stringify({ client_email: 'x@y', private_key: broken }))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/file itself is the problem/)
  })
  it('says when the file does not match what is deployed', () => {
    const prev = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON
    process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON = JSON.stringify({ private_key: 'a different key entirely' })
    try { expect(checkKeyFile(file).message).toMatch(/does NOT match the value currently deployed/) }
    finally { if (prev === undefined) delete process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON; else process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON = prev }
  })
  it('confirms a match when the deployed value holds the same key', () => {
    const prev = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON
    process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON = file
    try { expect(checkKeyFile(file).message).toMatch(/matches what is deployed/) }
    finally { if (prev === undefined) delete process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON; else process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON = prev }
  })
  it('rejects empty and non-key input without throwing', () => {
    expect(checkKeyFile('').ok).toBe(false)
    expect(checkKeyFile('hello').message).toMatch(/neither a key file nor a PEM/)
    expect(checkKeyFile('{ bad json').message).toMatch(/not valid JSON/)
  })
})
