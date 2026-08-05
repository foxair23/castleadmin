/**
 * Name-scoring core used by the remittance matcher's name-fallback stage. These
 * guard the two real cases the deterministic PO match couldn't handle: a PO never
 * entered in SF, and a wrong/transposed PO — both rescued by a customer-name match
 * that must be order- and comma-insensitive.
 */
import { describe, it, expect } from 'vitest'
import { nameScore, normName } from '@/lib/remittance/match'

describe('normName', () => {
  it('uppercases, strips punctuation, collapses whitespace', () => {
    expect(normName('Pearson, Tuyetle')).toBe('PEARSON TUYETLE')
    expect(normName('  Saeed   Suham ')).toBe('SAEED SUHAM')
  })
})

describe('nameScore', () => {
  it('scores reversed / comma-separated names as an exact match (case 2: PEARSON TUYETLE ↔ Pearson, Tuyetle)', () => {
    expect(nameScore('PEARSON TUYETLE', 'Pearson, Tuyetle')).toBe(1)
    expect(nameScore('PEARSON TUYETLE', 'Tuyetle Pearson')).toBe(1)
  })
  it('matches the same customer across lines (case 1: SAEED SUHAM)', () => {
    expect(nameScore('SAEED SUHAM', 'Saeed Suham')).toBe(1)
    expect(nameScore('SAEED SUHAM', 'Suham, Saeed')).toBe(1)
  })
  it('stays below the 0.9 strong threshold for different customers', () => {
    expect(nameScore('PEARSON TUYETLE', 'Pearson, John')).toBeLessThan(0.9)
    expect(nameScore('SAEED SUHAM', 'Michael Suham')).toBeLessThan(0.9)
    expect(nameScore('SAEED SUHAM', 'Jane Doe')).toBe(0)
  })
})
