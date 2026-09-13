import { describe, it, expect } from 'vitest'
import { checkReplyGuardrails, forbiddenNameTokens, serviceTermsFor, scrubNames, type GuardrailContext } from '@/lib/reputation/guardrails'

const ctx = (over: Partial<GuardrailContext> = {}): GuardrailContext => ({
  band: 'positive', hasJob: true,
  roster: ['Mark Rivera', 'Danny Ortiz', 'Will Sanchez', 'Jose Luis Garcia'],
  reviewerName: 'Sarah Johnson', customerName: 'Sarah Johnson', contactLastName: 'Johnson',
  street: '1291 Simpson Way', serviceTerms: ['garage door', 'spring'], city: 'Escondido', neighborhood: null,
  signature: 'Castle team', mentionedNames: [],
  ...over,
})
const GOOD_POS = 'Thank you, Sarah. We are glad the garage door spring replacement in Escondido went smoothly and that our technician left everything clean. Same-day service is something we work hard at, so it means a lot to hear it made a difference. We are here whenever the door needs us again.'
const GOOD_NEG = 'Thank you for the feedback, and we are sorry the garage door repair in Escondido did not go the way it should have. That is not the experience we want anyone to have, and we would like to make it right. Please call our office at (800) 576-1397 so a member of our team can hear the details directly and follow up with you. We appreciate you taking the time to tell us.'
const checks = (body: string, over: Partial<GuardrailContext> = {}) => checkReplyGuardrails(body, ctx(over)).failures.map(f => f.check)

describe('checkReplyGuardrails', () => {
  it('passes a good positive and a good negative reply', () => {
    expect(checkReplyGuardrails(GOOD_POS, ctx())).toMatchObject({ passed: true, failures: [] })
    expect(checkReplyGuardrails(GOOD_NEG, ctx({ band: 'negative', serviceTerms: ['garage door', 'repair'] }))).toMatchObject({ passed: true })
  })
  it('flags technician names, first or last, but not stoplisted words', () => {
    expect(checks(GOOD_POS.replace('our technician', 'Danny'))).toContain('tech_name')
    expect(checks(GOOD_POS.replace('our technician', 'Ortiz'))).toContain('tech_name')
    expect(checks(GOOD_POS + ' We will be here.')).not.toContain('tech_name') // "Will" is a stoplist word
    expect(checks(GOOD_POS.replace('our technician', 'Jose'))).toContain('tech_name')
  })
  it('flags names the reviewer wrote, but allows the reviewer’s own first name', () => {
    expect(checks(GOOD_POS.replace('our technician', 'Carlos'), { mentionedNames: ['Carlos'] })).toContain('tech_name')
    expect(checks(GOOD_POS, { mentionedNames: ['Sarah'] })).not.toContain('tech_name')
  })
  it('flags the customer surname but not an initial', () => {
    expect(checks(GOOD_POS.replace('Sarah', 'Sarah Johnson'))).toContain('customer_last_name')
    expect(checks(GOOD_POS.replace('Sarah', 'Mike'), { reviewerName: 'Mike T.', customerName: 'Mike T.', contactLastName: null })).not.toContain('customer_last_name')
  })
  it('flags street addresses and street names', () => {
    expect(checks(GOOD_POS + ' See you at 1291 Simpson Way.')).toContain('address')
    expect(checks(GOOD_POS + ' Simpson is a great street.')).toContain('address')
    expect(checks(GOOD_POS + ' We serve all of North County.')).not.toContain('address')
  })
  it('flags prices, warranty promises, and arguing on negative replies only', () => {
    expect(checks(GOOD_POS + ' It was only $150.')).toContain('price')
    expect(checks(GOOD_POS + ' Your warranty covers it.')).toContain('warranty')
    expect(checks(GOOD_NEG + " That's not true.", { band: 'negative', serviceTerms: ['garage door', 'repair'] })).toContain('arguing')
    expect(checks(GOOD_POS + " That's not true.")).not.toContain('arguing')
  })
  it('enforces the length band per band and job knowledge', () => {
    expect(checks('Thanks for the garage door review in Escondido.')).toContain('length')
    expect(checks('Thank you for the kind words about the garage door work in Escondido, we really appreciate you taking the time and hope to see you again soon.', { hasJob: false, serviceTerms: [], city: null })).not.toContain('length')
    expect(checks(GOOD_POS + ' ' + GOOD_POS + ' ' + GOOD_POS)).toContain('length')
  })
  it('requires the service and the city when known', () => {
    expect(checks(GOOD_POS.replace('garage door spring replacement', 'work'))).toContain('service_type')
    expect(checks(GOOD_POS.replace('in Escondido', ''))).toContain('city')
    expect(checks(GOOD_POS.replace('in Escondido', 'in Rancho Bernardo'), { neighborhood: 'Rancho Bernardo' })).not.toContain('city')
    expect(checks(GOOD_POS.replace('in Escondido', ''), { city: null })).not.toContain('city')
  })
  it('rejects a signature or a name sign-off in the body', () => {
    expect(checks(GOOD_POS + '\n\n— Castle team')).toContain('signature')
    expect(checks(GOOD_POS + '\n\n— John')).toContain('signature')
  })
})

describe('helpers', () => {
  it('builds forbidden name tokens without short or stoplisted words', () => {
    const t = forbiddenNameTokens(['Will Sanchez', 'Al Bo', 'Jose Luis Garcia'])
    expect(t).toContain('sanchez'); expect(t).toContain('will sanchez'); expect(t).toContain('luis')
    expect(t).not.toContain('will'); expect(t).not.toContain('al'); expect(t).not.toContain('bo')
  })
  it('derives service terms from the category and line items', () => {
    const t = serviceTermsFor('Garage Door Repair', ['Torsion Spring', 'Labor'])
    expect(t).toEqual(expect.arrayContaining(['garage door', 'repair', 'torsion spring', 'torsion', 'spring']))
    expect(t).not.toContain('labor')
    expect(serviceTermsFor(null, [])).toEqual([])
    expect(serviceTermsFor('Estimate', [])).toEqual(['estimate'])
  })
  it('scrubs roster names out of job notes', () => {
    expect(scrubNames('Danny Ortiz replaced both springs; Danny noted the opener is old.', ['Danny Ortiz'])).toBe('our technician replaced both springs; our technician noted the opener is old.')
    expect(scrubNames(null, [])).toBeNull()
  })
})

import { checkPostGuardrails, type PostGuardrailContext } from '@/lib/reputation/guardrails'

const pctx = (over: Partial<PostGuardrailContext> = {}): PostGuardrailContext => ({
  roster: ['Danny Ortiz'], customerName: 'Sarah Johnson', contactLastName: 'Johnson', street: '1291 Simpson Way',
  serviceTerms: ['garage door', 'install'], city: 'Carlsbad', ...over,
})
const GOOD_POST = 'New double garage door installed in Carlsbad this week. The old door had a cracked panel and a tired opener, so our team replaced it with an insulated steel door and a quiet belt-drive unit, then tuned the springs and safety sensors before we left. The homeowner wanted something that matched the trim of the house, and the finished door above shows how it came together. Castle has been installing garage doors across San Diego County since 1981, and most installs like this one are done in a single visit. Need a hand with yours? Tap Learn more.'
const pchecks = (body: string, over: Partial<PostGuardrailContext> = {}) => checkPostGuardrails(body, pctx(over)).failures.map(f => f.check)

describe('checkPostGuardrails', () => {
  it('passes a good post', () => {
    expect(checkPostGuardrails(GOOD_POST, pctx())).toMatchObject({ passed: true, failures: [] })
  })
  it('applies the shared identity checks and the no-price rule', () => {
    expect(pchecks(GOOD_POST.replace('our team', 'Danny'))).toContain('tech_name')
    expect(pchecks(GOOD_POST.replace('The homeowner', 'The Johnsons'))).not.toContain('customer_last_name') // plural form is not the surname token
    expect(pchecks(GOOD_POST.replace('The homeowner', 'Mrs. Johnson'))).toContain('customer_last_name')
    expect(pchecks(GOOD_POST + ' Find us at 1291 Simpson Way.')).toContain('address')
    expect(pchecks(GOOD_POST.replace('single visit', 'single visit for $1,200'))).toContain('price')
    expect(pchecks(GOOD_POST + ' Lifetime warranty included.')).toContain('warranty')
  })
  it('enforces length, service, city, and format', () => {
    expect(pchecks('Garage door installed in Carlsbad. Tap Learn more.')).toContain('length')
    expect(pchecks(GOOD_POST.replace(/garage door/g, 'thing').replace('installing', 'doing').replace('installs', 'jobs').replace('installed', 'done'))).toContain('service_type')
    expect(pchecks(GOOD_POST.replace(/Carlsbad/g, 'town'))).toContain('city')
    expect(pchecks(GOOD_POST + ' #garagedoor')).toContain('format')
    expect(pchecks(GOOD_POST + ' 🚪')).toContain('format')
  })
})
