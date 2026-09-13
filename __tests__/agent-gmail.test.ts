import { describe, it, expect } from 'vitest'
import { parseAddressList, htmlToText, toInboundEmail, buildRfc822, textToHtml } from '@/lib/agent/email/gmail'

const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('parseAddressList', () => {
  it('handles names, quotes, bare addresses, and lists', () => {
    expect(parseAddressList('"Doe, Jane" <Jane.Doe@HomeDepot.com>, bob@clopay.com, Sam K <sam@x.com>')).toEqual([
      { addr: 'jane.doe@homedepot.com', name: 'Doe, Jane' }, { addr: 'bob@clopay.com', name: null }, { addr: 'sam@x.com', name: 'Sam K' },
    ])
    expect(parseAddressList(undefined)).toEqual([])
  })
})

describe('htmlToText', () => {
  it('keeps paragraphs and marks blockquotes as quoted lines', () => {
    const t = htmlToText('<div>Any update?</div><br><blockquote>The install is Thursday.</blockquote><style>x{}</style>&amp; thanks')
    expect(t).toBe('Any update?\n\n> The install is Thursday.\n& thanks')
  })
})

describe('toInboundEmail', () => {
  it('maps a full Gmail message, preferring text/plain and lower-casing headers', () => {
    const e = toInboundEmail({
      id: 'm1', threadId: 't1', internalDate: '1757300000000',
      payload: {
        headers: [{ name: 'From', value: 'Store 6614 <store6614@homedepot.com>' }, { name: 'To', value: 'info@castlegarage.com' }, { name: 'Cc', value: 'cassie@castlegarage.com' },
          { name: 'Subject', value: 'PO 1020259181' }, { name: 'Message-ID', value: '<abc@hd>' }, { name: 'Auto-Submitted', value: 'no' }],
        parts: [{ mimeType: 'text/html', body: { data: b64url('<b>html</b>') } }, { mimeType: 'text/plain', body: { data: b64url('plain body') } }],
      },
    })
    expect(e).toMatchObject({ source: 'gmail', gmailMessageId: 'm1', gmailThreadId: 't1', internetMessageId: '<abc@hd>', subject: 'PO 1020259181', bodyText: 'plain body' })
    expect(e.from).toEqual({ addr: 'store6614@homedepot.com', name: 'Store 6614' })
    expect(e.cc[0].addr).toBe('cassie@castlegarage.com')
    expect(e.headers['auto-submitted']).toBe('no')
    expect(e.receivedAt).toBe(new Date(1757300000000).toISOString())
  })
  it('falls back to html when there is no plain part', () => {
    const e = toInboundEmail({ id: 'm', threadId: 't', payload: { mimeType: 'text/html', body: { data: b64url('<p>Hi</p><p>there</p>') }, headers: [] } })
    expect(e.bodyText).toBe('Hi\nthere')
  })
})

describe('buildRfc822', () => {
  it('threads into the partner conversation and carries Reply-To + Cc', () => {
    const raw = buildRfc822({
      fromName: 'Cassie (Castle AI Agent)', fromAddr: 'cassie@castlegarage.com', to: '"Jane Doe" <jane@homedepot.com>', cc: ['info@castlegarage.com'],
      replyTo: 'info@castlegarage.com', subject: 'Re: PO 1020259181', text: 'Hi Jane,\n\nFound it.', inReplyTo: '<abc@hd>', references: ['<root@hd>', '<abc@hd>'], gmailThreadId: 't1',
    })
    const lines = raw.split('\r\n')
    expect(lines).toContain('From: "Cassie (Castle AI Agent)" <cassie@castlegarage.com>')
    expect(lines).toContain('Cc: info@castlegarage.com')
    expect(lines).toContain('Reply-To: info@castlegarage.com')
    expect(lines).toContain('In-Reply-To: <abc@hd>')
    expect(lines).toContain('References: <root@hd> <abc@hd>')
    // Both parts carry the body: plain text for the record, HTML so Gmail shows it at full
    // width in a normal font instead of a narrow hard-wrapped column.
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/)
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\nHi Jane,\n\nFound it.')
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"')
    expect(raw).toContain('<p style="margin:0 0 1em 0">Hi Jane,</p><p style="margin:0 0 1em 0">Found it.</p>')
    expect(raw.trimEnd().endsWith('--')).toBe(true)
  })
  it('renders the text as paragraphs with escaped HTML', () => {
    expect(textToHtml('A <b>\nB\n\nC & D')).toBe('<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222"><p style="margin:0 0 1em 0">A &lt;b&gt;<br>B</p><p style="margin:0 0 1em 0">C &amp; D</p></div>')
  })
  it('encodes a non-ASCII subject', () => {
    const raw = buildRfc822({ fromName: 'C', fromAddr: 'c@x.com', to: 'a@b.com', cc: [], replyTo: 'r@x.com', subject: 'Re: Señor García', text: 'x', inReplyTo: null, references: [], gmailThreadId: null })
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/)
  })
})
