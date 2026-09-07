import { describe, it, expect } from 'vitest'
import { parseAddressList, htmlToText, toInboundEmail, buildRfc822 } from '@/lib/agent/email/gmail'

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
    expect(raw.endsWith('\r\n\r\nHi Jane,\n\nFound it.')).toBe(true)
  })
  it('encodes a non-ASCII subject', () => {
    const raw = buildRfc822({ fromName: 'C', fromAddr: 'c@x.com', to: 'a@b.com', cc: [], replyTo: 'r@x.com', subject: 'Re: Señor García', text: 'x', inReplyTo: null, references: [], gmailThreadId: null })
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/)
  })
})
