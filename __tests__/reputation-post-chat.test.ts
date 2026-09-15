import { describe, it, expect } from 'vitest'
import { photoLines } from '@/lib/reputation/post-chat'
import type { JobPhotoRow } from '@/lib/reputation/photos'

const photo = (over: Partial<JobPhotoRow>): JobPhotoRow => ({
  id: 'p1', sf_job_id: 'j1', source: 'sf', source_ref: 'r', source_name: null,
  storage_path: 'jobs/j1/a.jpg', public_url: 'https://x/a.jpg', width: 1200, height: 800, bytes: 1,
  score: 80, score_reasons: [], shows: 'finished', subject: null, pair_id: null, override_usable: null,
  scored_at: null, score_model: null, error: null, created_at: '', updated_at: '', ...over,
})

describe('photoLines', () => {
  it('numbers the photos and says which are in the post', () => {
    const rows = [
      photo({ id: 'a', shows: 'before', score: 55, subject: 'cracked white door', score_reasons: ['panel is damaged'] }),
      photo({ id: 'b', shows: 'finished', score: 92, subject: 'new white raised panel door' }),
    ]
    const out = photoLines(rows, ['b'])
    expect(out).toContain('#1 · labelled before · score 55 · shows "cracked white door"')
    expect(out).toContain('scorer said: panel is damaged')
    expect(out).toContain('#2')
    expect(out).toContain('IN THIS POST (position 1)')
    expect(out.split('\n')).toHaveLength(2)
  })
  it('flags what a person forced, and photos with no image', () => {
    const out = photoLines([
      photo({ id: 'a', override_usable: false }),
      photo({ id: 'b', override_usable: true }),
      photo({ id: 'c', public_url: null, score: null, shows: null }),
    ], [])
    expect(out).toContain('blocked by a person')
    expect(out).toContain('forced allowed by a person')
    expect(out).toContain('not scored yet · no score')
    expect(out).toContain('no image (not imported)')
  })
  it('says so when a job has no photos', () => {
    expect(photoLines([], [])).toBe('No photos have been pulled in for this job.')
  })
})
