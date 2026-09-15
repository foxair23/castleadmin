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

import { splitCandidates, emptyReason, type CandidateJob } from '@/lib/reputation/post-drafter'

const job = (id: string, completedAt: string, category: string | null): CandidateJob => ({
  id, number: id, category, description: null, completion_notes: null, city: 'Vista', postal_code: '92084',
  work_completed_at: completedAt, customer_name: null, contact_last_name: null, street_1: null,
})

describe('splitCandidates', () => {
  const settings = { posts_since: '2026-09-13T07:00:00.000Z', post_allowed_categories: [] as string[] }
  const jobs = [
    job('a', '2026-09-14T18:00:00+00:00', 'Garage Door Repair'),   // usable
    job('b', '2026-08-02T18:00:00+00:00', 'Garage Door Install'),  // finished before the start date
    job('c', '2026-09-14T19:00:00+00:00', 'Service Call'),         // category never posts
    job('d', '2026-09-14T20:00:00+00:00', 'Service Call'),
    job('e', '2026-09-14T21:00:00+00:00', 'Gate Install'),         // already has a post
  ]
  it('counts each gate a finished job was dropped at, and names the blocking categories', () => {
    const { jobs: keep, breakdown } = splitCandidates(jobs, settings, new Set(['e']))
    expect(keep.map(j => j.id)).toEqual(['a'])
    expect(breakdown).toMatchObject({ finished: 5, beforeSince: 1, wrongCategory: 2, alreadyPosted: 1 })
    expect(breakdown.blockedCategories).toEqual([{ category: 'Service Call', count: 2 }])
  })
  it('ignores the start date when the owner named the days', () => {
    const { breakdown } = splitCandidates(jobs, settings, new Set(), { ignorePostsSince: true })
    expect(breakdown.beforeSince).toBe(0)
    expect(splitCandidates(jobs, settings, new Set(), { ignorePostsSince: true }).jobs.map(j => j.id)).toEqual(['a', 'b', 'e'])
  })
  it('honours an explicit allow-list over the default exclusions', () => {
    const { jobs: keep, breakdown } = splitCandidates(jobs, { ...settings, post_allowed_categories: ['Service Call'] }, new Set())
    expect(keep.map(j => j.id)).toEqual(['c', 'd'])
    expect(breakdown.wrongCategory).toBe(2)
  })
  it('explains an empty window in one sentence, pointing at the setting to change', () => {
    const { breakdown } = splitCandidates(jobs, settings, new Set(['e']))
    const why = emptyReason({ ...breakdown, finished: 4, alreadyPosted: 1 }, settings.posts_since)
    expect(why).toContain('Service Call ×2')
    expect(why).toContain('posts start date of 2026-09-13')
    expect(why).toContain('Settings → Profile posts')
  })
})
