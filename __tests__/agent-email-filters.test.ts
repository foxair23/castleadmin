import { describe, it, expect } from 'vitest'
import { applyHardFilters, stripQuotedHistory, isAutoReply, isNoReplySender, deliveryPath } from '@/lib/agent/email/filters'
import { extractIdentifiers } from '@/lib/agent/email/identifiers'
import { replayEmail } from '@/lib/agent/email/pipeline'
import { mergeSettings } from '@/lib/agent/settings'
import type { ThreadState } from '@/lib/agent/email/types'

const settings = mergeSettings({ processing_enabled: true, allowlist_domains: ['homedepot.com', 'clopay.com'], blocklist_addresses: ['spam@homedepot.com'] })
const fresh: ThreadState = { agentReplied: false, humanRepliedAfterInquiry: false, priorInbound: 0 }
const mail = (over: Partial<Parameters<typeof replayEmail>[0]> = {}) => replayEmail({
  from: 'store.manager@homedepot.com', to: 'info@castlegarage.com', subject: 'PO 1020259181 status', body: 'Any update on PO 1020259181 for Mrs. Coorey?', ...over,
})

describe('hard filters', () => {
  it('processing off drops everything, even good senders', () => {
    const r = applyHardFilters(mail(), mergeSettings({ processing_enabled: false, allowlist_domains: ['homedepot.com'] }), fresh)
    expect(r).toMatchObject({ pass: false, reason: 'processing_off' })
  })
  it('an allowlisted partner with a real question passes', () => {
    expect(applyHardFilters(mail(), settings, fresh)).toEqual({ pass: true, deliveryPath: 'distribution' })
  })
  it('direct-to-Cassie mail is flagged direct but earns no extra trust', () => {
    expect(applyHardFilters(mail({ to: 'cassie@castlegarage.com' }), settings, fresh)).toEqual({ pass: true, deliveryPath: 'direct' })
    expect(applyHardFilters(mail({ from: 'rando@gmail.com', to: 'cassie@castlegarage.com' }), settings, fresh)).toMatchObject({ pass: false, reason: 'not_allowlisted' })
  })
  it('non-allowlisted and blocklisted senders are silent drops', () => {
    expect(applyHardFilters(mail({ from: 'someone@lowes.com' }), settings, fresh)).toMatchObject({ pass: false, reason: 'not_allowlisted' })
    expect(applyHardFilters(mail({ from: 'spam@homedepot.com' }), settings, fresh)).toMatchObject({ pass: false, reason: 'blocklisted' })
  })
  it('no-reply style senders are dropped', () => {
    expect(applyHardFilters(mail({ from: 'no-reply@homedepot.com' }), settings, fresh)).toMatchObject({ pass: false, reason: 'noreply_sender' })
    expect(applyHardFilters(mail({ from: 'DoNotReply@clopay.com' }), settings, fresh)).toMatchObject({ pass: false, reason: 'noreply_sender' })
    expect(isNoReplySender('orders-notifications@clopay.com')).toBe(true)
    expect(isNoReplySender('jane.doe@clopay.com')).toBe(false)
  })
  it('auto-replies and out-of-office are dropped by header or subject', () => {
    expect(applyHardFilters(mail({ headers: { 'Auto-Submitted': 'auto-replied' } }), settings, fresh)).toMatchObject({ pass: false, reason: 'auto_reply' })
    expect(applyHardFilters(mail({ headers: { 'X-Autoreply': 'yes' } }), settings, fresh)).toMatchObject({ pass: false, reason: 'auto_reply' })
    expect(applyHardFilters(mail({ subject: 'Automatic reply: PO 1020259181 status' }), settings, fresh)).toMatchObject({ pass: false, reason: 'auto_reply' })
    expect(applyHardFilters(mail({ subject: 'Out of Office Re: PO status' }), settings, fresh)).toMatchObject({ pass: false, reason: 'auto_reply' })
    expect(isAutoReply({ 'auto-submitted': 'no' }, 'Re: PO status')).toBeNull()
  })
  it('bulk / list mail is dropped', () => {
    expect(applyHardFilters(mail({ headers: { Precedence: 'bulk' } }), settings, fresh)).toMatchObject({ pass: false, reason: 'bulk_mail' })
    expect(applyHardFilters(mail({ headers: { 'List-Unsubscribe': '<mailto:x>' } }), settings, fresh)).toMatchObject({ pass: false, reason: 'bulk_mail' })
  })
  it("Cassie's own mail and Castle staff mail are never inquiries", () => {
    expect(applyHardFilters(mail({ from: 'cassie@castlegarage.com' }), settings, fresh)).toMatchObject({ pass: false, reason: 'own_address' })
    expect(applyHardFilters(mail({ from: 'jfox@castlegarage.com' }), settings, fresh)).toMatchObject({ pass: false, reason: 'human_reply' })
    expect(applyHardFilters(mail({ from: 'office@castlegaragedoors.com' }), settings, fresh)).toMatchObject({ pass: false, reason: 'human_reply' })
  })
  it('a message that is only quoted history is dropped', () => {
    expect(applyHardFilters(mail({ body: '> old stuff\n> more old stuff' }), settings, fresh)).toMatchObject({ pass: false, reason: 'empty_body' })
  })
  it('thread discipline: one reply per thread, and never after a human', () => {
    expect(applyHardFilters(mail(), settings, { ...fresh, agentReplied: true })).toMatchObject({ pass: false, reason: 'thread_actioned' })
    expect(applyHardFilters(mail(), settings, { ...fresh, humanRepliedAfterInquiry: true })).toMatchObject({ pass: false, reason: 'human_replied' })
  })
  it('deliveryPath sees CC too', () => {
    expect(deliveryPath(mail({ to: 'info@castlegarage.com', cc: 'cassie@castlegarage.com' }), settings)).toBe('direct')
  })
})

describe('stripQuotedHistory', () => {
  it('cuts Gmail "On ... wrote:" and > quoted lines', () => {
    const t = 'Any update?\n\nOn Mon, Sep 7, 2026 at 9:12 AM Castle <info@castlegarage.com> wrote:\n> The install is Thursday.\n> Thanks'
    expect(stripQuotedHistory(t)).toBe('Any update?')
  })
  it('cuts Outlook original-message blocks', () => {
    const t = 'Please advise.\n\n-----Original Message-----\nFrom: Castle\nSent: Monday\nSubject: Re: PO\nBody here'
    expect(stripQuotedHistory(t)).toBe('Please advise.')
    const t2 = 'Please advise.\n\nFrom: Castle <info@castlegarage.com>\nSent: Monday, September 7\nTo: HD\nSubject: Re: PO'
    expect(stripQuotedHistory(t2)).toBe('Please advise.')
  })
  it('keeps a plain message intact', () => {
    expect(stripQuotedHistory('Line one\n\nLine two')).toBe('Line one\n\nLine two')
  })
})

describe('extractIdentifiers', () => {
  it('finds labelled and bare POs, deduped and normalised', () => {
    const r = extractIdentifiers('Status on PO# 1020259181 and order 1020259182? Also 1020259181 again. Job # 73437205.')
    expect(r.pos).toEqual(['1020259181', '1020259182', '73437205'])
  })
  it('separates formatted phones from bare 10-digit POs', () => {
    const r = extractIdentifiers('Customer cell (619) 555-1234. PO 1020259181. Call 619-555-9999.')
    expect(r.pos).toEqual(['1020259181'])
    expect(r.phones).toEqual(['6195551234', '6195559999'])
    expect(r.phone).toBe('6195551234')
  })
  it('a bare 10-digit run after "phone" is a phone, not a PO', () => {
    const r = extractIdentifiers('Her phone: 6195551234. PO 1020259181')
    expect(r.pos).toEqual(['1020259181'])
  })
  it('collects other emails but not the excluded ones', () => {
    const r = extractIdentifiers('Customer is tina@example.com, cc jane@homedepot.com', { excludeEmails: ['jane@homedepot.com'] })
    expect(r.emails).toEqual(['tina@example.com'])
    expect(r.email).toBe('tina@example.com')
  })
  it('empty body → nothing', () => {
    expect(extractIdentifiers('')).toMatchObject({ pos: [], phones: [], emails: [], email: null, phone: null })
  })
})

// info@castlegarage.com is a Google Group: Google rewrites From to the group and moves the
// partner to Reply-To / X-Original-Sender. Cassie must see the partner, not "Castle staff".
describe('Google Group relay', () => {
  const relayed = (over: Partial<Parameters<typeof replayEmail>[0]> = {}) => replayEmail({
    from: 'info@castlegarage.com', fromName: "'DC St. Louis' via Info", to: 'info@castlegarage.com',
    subject: 'Re: Store# 1018 PO# 18498073 STEVENS JENNIFER Ticket: [#5923818]',
    body: 'Hello,\n\nDo you have an install date for this customer? If so, could you please update the ticket?\n\nThanks,\nKaylee',
    headers: { 'Reply-To': '"DC St. Louis" <clopaystlorders@clopay.com>', 'X-Original-Sender': 'clopaystlorders@clopay.com', 'X-Google-Group-Id': '123456', 'List-Id': '<info.castlegarage.com>', 'List-Unsubscribe': '<mailto:info+unsubscribe@castlegarage.com>', 'Precedence': 'list', 'Mailing-list': 'list info@castlegarage.com' },
    ...over,
  })
  it('restores the partner as the sender and notes the group', () => {
    const e = relayed()
    expect(e.from).toEqual({ addr: 'clopaystlorders@clopay.com', name: 'DC St. Louis' })
    expect(e.relayedVia).toBe('info@castlegarage.com')
  })
  it('passes the hard filters as a partner inquiry despite the group list headers', () => {
    expect(applyHardFilters(relayed(), settings, fresh)).toEqual({ pass: true, deliveryPath: 'distribution' })
  })
  it('still treats a real Castle person writing through the group as a human reply', () => {
    const e = replayEmail({ from: 'info@castlegarage.com', fromName: "'Tiffany Christakes' via Info", to: 'info@castlegarage.com', subject: 'Re: color request', body: 'I will get an estimate prepared.', headers: { 'Reply-To': 'tiffany@castlegarage.com', 'X-Original-Sender': 'tiffany@castlegarage.com' } })
    expect(e.from.addr).toBe('tiffany@castlegarage.com')
    expect(applyHardFilters(e, settings, fresh)).toMatchObject({ pass: false, reason: 'human_reply' })
  })
  it('does not unwrap a plain Castle sender, and a relayed newsletter is still bulk', () => {
    expect(replayEmail({ from: 'info@castlegarage.com', to: 'x@y.com', subject: 's', body: 'b' }).relayedVia).toBeUndefined()
    expect(applyHardFilters(relayed({ headers: { 'Reply-To': 'news@clopay.com', 'X-Original-Sender': 'news@clopay.com', 'Precedence': 'bulk' } }), settings, fresh)).toMatchObject({ pass: false, reason: 'bulk_mail' })
  })
})
