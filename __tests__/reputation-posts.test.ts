import { describe, it, expect } from 'vitest'
import { categoryAllowed } from '@/lib/reputation/post-drafter'

describe('categoryAllowed', () => {
  it('uses the allow-list when set, else excludes the usual non-work categories', () => {
    expect(categoryAllowed('Garage Door Install', [])).toBe(true)
    expect(categoryAllowed('Warranty', [])).toBe(false)
    expect(categoryAllowed('Service Call', [])).toBe(false)
    expect(categoryAllowed('Estimate', [])).toBe(false)
    expect(categoryAllowed(null, [])).toBe(false)
    expect(categoryAllowed('Service Call', ['service call'])).toBe(true)
    expect(categoryAllowed('Garage Door Install', ['Gate Install'])).toBe(false)
  })
})

import { splitCandidates, type CandidateJob } from '@/lib/reputation/post-drafter'

const job = (id: string, completedAt: string, category: string | null): CandidateJob => ({
  id, number: id, category, description: null, completion_notes: null, city: 'Vista', postal_code: '92084',
  work_completed_at: completedAt, customer_name: null, contact_last_name: null, street_1: null,
})

describe('splitCandidates', () => {
  const settings = { posts_since: '2026-09-13T07:00:00.000Z', post_allowed_categories: [] as string[] }
  const jobs = [
    job('a', '2026-09-14T18:00:00+00:00', 'Garage Door Repair'),   // usable
    job('b', '2026-08-02T18:00:00+00:00', 'Garage Door Install'),  // before the start date
    job('c', '2026-09-14T19:00:00+00:00', 'Service Call'),         // category never posts
    job('d', '2026-09-14T20:00:00+00:00', 'Service Call'),
    job('e', '2026-09-14T21:00:00+00:00', 'Gate Install'),         // already has a post
  ]
  it('counts each reason a finished job was dropped', () => {
    const { jobs: keep, breakdown } = splitCandidates(jobs, settings, new Set(['e']))
    expect(keep.map(j => j.id)).toEqual(['a'])
    expect(breakdown).toMatchObject({ finished: 5, beforeSince: 1, categoryBlocked: 2, alreadyPosted: 1, usable: 1 })
    expect(breakdown.blockedCategories).toEqual([{ category: 'Service Call', count: 2 }])
  })
  it('ignores the start date when the owner named the days', () => {
    const { breakdown } = splitCandidates(jobs, settings, new Set(), { ignorePostsSince: true })
    expect(breakdown).toMatchObject({ beforeSince: 0, usable: 3 })
  })
  it('honours an explicit allow-list over the default exclusions', () => {
    const { breakdown } = splitCandidates(jobs, { ...settings, post_allowed_categories: ['Service Call'] }, new Set())
    expect(breakdown).toMatchObject({ categoryBlocked: 2, usable: 2 })
  })
})
