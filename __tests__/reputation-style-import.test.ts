import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { parseCsv, extractReviewExamples, filterExamples, bandForStars } from '@/lib/reputation/style-import'

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded newlines and CRLF', () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n,\r\n')
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']])
  })
  it('strips a BOM', () => {
    expect(parseCsv('﻿stars,text\n5,ok')).toEqual([['stars', 'text'], ['5', 'ok']])
  })
})

describe('extractReviewExamples', () => {
  it('reads the Apify Google Maps Reviews export', () => {
    const csv = readFileSync(new URL('./fixtures/google-maps-reviews-export.csv', import.meta.url), 'utf8')
    const { rows, error, columns } = extractReviewExamples(csv)
    expect(error).toBeUndefined()
    expect(columns).toEqual({ reply: 'responseFromOwnerText', review: 'text', stars: 'stars' })
    expect(rows.length).toBe(4)
    expect(rows[0]).toMatchObject({ stars: 5, business: 'Wilson Plumbing, Heating, Cooling and Electric' })
    expect(rows[0].reply.startsWith('Gundy, thank you')).toBe(true)
    expect(rows[0].review?.startsWith('Wilson Plumbing')).toBe(true)
    // a review with a reply but no review text is still usable
    expect(rows.find(r => r.review == null)).toBeTruthy()
  })
  it('accepts other column names and reports a missing reply column', () => {
    const ok = extractReviewExamples('Rating,Review,Owner Response\n4,"good","Thanks for coming by, we appreciate the kind words about the install"')
    expect(ok.rows).toEqual([{ stars: 4, review: 'good', reply: 'Thanks for coming by, we appreciate the kind words about the install', business: null }])
    expect(extractReviewExamples('stars,text\n5,hi').error).toMatch(/No owner-reply column/)
  })
})

describe('filterExamples', () => {
  it('drops short replies, unrated rows and duplicates', () => {
    const long = 'Thank you so much for taking the time to leave us this kind and detailed review today'
    const rows = [
      { stars: 5, review: null, reply: 'Thanks, Ed!', business: null },
      { stars: null, review: null, reply: long, business: null },
      { stars: 5, review: null, reply: long, business: null },
      { stars: 2, review: 'late', reply: `${long}  `, business: null },
    ]
    const { keep, skipped } = filterExamples(rows, { minReplyWords: 12, requireStars: true })
    expect(keep.length).toBe(1); expect(keep[0].stars).toBe(5)
    expect(skipped).toEqual({ short: 1, noStars: 1, duplicate: 1 })
    expect(filterExamples(rows, { minReplyWords: 0, requireStars: false }).keep.length).toBe(2)
  })
  it('bands by stars, defaulting unknown to positive', () => {
    expect([bandForStars(5), bandForStars(4), bandForStars(3), bandForStars(null)]).toEqual(['positive', 'positive', 'negative', 'positive'])
  })
})

import { extractPostExamples, filterPostExamples } from '@/lib/reputation/style-import'
import { normalizeAssignments } from '@/lib/reputation/post-categorize'

describe('post CSV import', () => {
  const csv = '"author","date","images/0","placeName","placeUrl","section","text"\n' +
    '"Wilson Plumbing","12 hours ago","https://x/1.jpg","Wilson Plumbing","https://maps","From the owner","AC not cooling? In Stow we inspected an older Carrier system and found the outdoor compressor had failed, which explained the warm air. We walked the homeowners through options."\n' +
    '"Wilson Plumbing","1 day ago","","Wilson Plumbing","","From the owner","Happy Friday everyone!"\n' +
    '"Wilson Plumbing","2 days ago","","Wilson Plumbing","","From the owner","AC not cooling? In Stow we inspected an older Carrier system and found the outdoor compressor had failed, which explained the warm air. We walked the homeowners through options."\n' +
    '"Acme Doors","3 days ago","","Acme Doors","","From the owner",""\n'
  it('reads the text and business columns from the scraper export', () => {
    const ex = extractPostExamples(csv)
    expect(ex.error).toBeUndefined()
    expect(ex.columns).toEqual({ text: 'text', business: 'author' })
    expect(ex.rows).toHaveLength(3)
    expect(ex.rows[0].business).toBe('Wilson Plumbing')
  })
  it('drops stubs and duplicates', () => {
    const { keep, skipped } = filterPostExamples(extractPostExamples(csv).rows)
    expect(keep).toHaveLength(1)
    expect(skipped).toEqual({ short: 1, long: 0, duplicate: 1 })
    expect(filterPostExamples([{ text: 'word '.repeat(400), business: null }]).skipped.long).toBe(1)
  })
  it('explains a file without a text column', () => {
    expect(extractPostExamples('"a","b"\n"1","2"\n').error).toMatch(/No post text column/)
  })
  it('maps the AI assignments back by index and only to known categories', () => {
    const out = normalizeAssignments({ assignments: [{ index: 0, category: 'repair' }, { index: 1, category: 'Snow removal' }, { index: 7, category: 'Repair' }, { index: 2, category: null }] }, 3, ['Repair', 'Install'])
    expect(out).toEqual(['Repair', null, null])
    expect(normalizeAssignments(null, 2, ['Repair'])).toEqual([null, null])
  })
})
