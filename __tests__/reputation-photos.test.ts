import { describe, it, expect } from 'vitest'
import { parseSfPictures, normalizePhotoScores, pickPostPhotos, type JobPhotoRow } from '@/lib/reputation/photos'

describe('parseSfPictures', () => {
  it('reads pictures off a direct job object or a list wrapper, skipping private and non-image files', () => {
    const pics = [
      { name: 'after.jpg', file_location: 'https://x/after.jpg', doc_type: 'image/jpeg', is_private: false, sort: 2 },
      { name: 'before.jpg', file_location: 'https://x/before.jpg', is_private: false, sort: 1 },
      { name: 'invoice.pdf', file_location: 'https://x/invoice.pdf', doc_type: 'application/pdf' },
      { name: 'secret.jpg', file_location: 'https://x/secret.jpg', is_private: true },
      { name: 'dup', file_location: 'https://x/after.jpg' },
    ]
    const direct = parseSfPictures({ id: 1, pictures: pics })
    expect(direct.map(p => p.name)).toEqual(['before.jpg', 'after.jpg'])
    const wrapped = parseSfPictures({ items: [{ id: 1, pictures: pics }] })
    expect(wrapped).toHaveLength(2)
    expect(parseSfPictures({ id: 1 })).toEqual([])
    expect(parseSfPictures(null)).toEqual([])
  })
})

describe('normalizePhotoScores', () => {
  it('clamps scores, drops out-of-range indexes and overlapping pairs', () => {
    const r = normalizePhotoScores({
      photos: [{ index: 1, score: 130, reasons: ['clean', ''], shows: 'after', subject: ' door ' }, { index: 2, score: -5, reasons: 'x', shows: 'weird', subject: null }, { index: 9, score: 50, reasons: [], shows: 'other', subject: null }, { index: 1, score: 1, reasons: [], shows: 'other', subject: null }],
      pairs: [{ before_index: 2, after_index: 1 }, { before_index: 1, after_index: 3 }, { before_index: 3, after_index: 3 }],
    }, 3)
    expect(r.photos).toEqual([{ index: 1, score: 100, reasons: ['clean'], shows: 'after', subject: 'door' }, { index: 2, score: 0, reasons: [], shows: 'other', subject: null }])
    expect(r.pairs).toEqual([[2, 1]])
  })
  it('tolerates garbage', () => {
    expect(normalizePhotoScores(undefined, 2)).toEqual({ photos: [], pairs: [] })
  })
})

const photo = (over: Partial<JobPhotoRow>): JobPhotoRow => ({
  id: 'p', sf_job_id: 'j', source: 'sf', source_ref: 'r', source_name: null, storage_path: 'x', public_url: 'https://cdn/x.jpg', width: 1200, height: 900, bytes: 1,
  score: 80, score_reasons: [], shows: 'finished', subject: null, pair_id: null, override_usable: null, scored_at: null, score_model: null, error: null, created_at: '', updated_at: '', ...over,
})

describe('pickPostPhotos', () => {
  it('prefers a usable before/after pair, else the best single non-before photo', () => {
    const a = photo({ id: 'a', score: 95, shows: 'finished' })
    const b1 = photo({ id: 'b1', score: 72, shows: 'before', pair_id: 'pr' })
    const b2 = photo({ id: 'b2', score: 88, shows: 'after', pair_id: 'pr' })
    expect(pickPostPhotos([a, b1, b2], 70).map(p => p.id)).toEqual(['b1', 'b2'])
    expect(pickPostPhotos([a, { ...b1, score: 40 }, b2], 70).map(p => p.id)).toEqual(['a'])
  })
  it('respects the threshold and admin overrides, and never posts a lone before shot', () => {
    expect(pickPostPhotos([photo({ score: 60 })], 70)).toEqual([])
    expect(pickPostPhotos([photo({ id: 'o', score: 60, override_usable: true })], 70).map(p => p.id)).toEqual(['o'])
    expect(pickPostPhotos([photo({ score: 95, override_usable: false })], 70)).toEqual([])
    expect(pickPostPhotos([photo({ score: 95, shows: 'before' })], 70)).toEqual([])
    expect(pickPostPhotos([photo({ score: 95, public_url: null })], 70)).toEqual([])
  })
})
