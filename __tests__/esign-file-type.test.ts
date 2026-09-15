import { describe, it, expect } from 'vitest'
import { sniffFileType, describeNotPdf, previewBytes } from '@/lib/esign/file-type'

const bytes = (...v: number[]) => new Uint8Array(v)
const text = (s: string) => new Uint8Array([...s].map(c => c.charCodeAt(0)))
const padded = (u: Uint8Array, size: number) => { const out = new Uint8Array(size); out.set(u); return out }

describe('sniffFileType', () => {
  it('knows a PDF, even behind a byte-order mark', () => {
    expect(sniffFileType(text('%PDF-1.7\nstuff'))).toBe('pdf')
    expect(sniffFileType(text('﻿  %PDF-1.4'))).toBe('pdf')
  })
  it('knows the things that turn up instead of one', () => {
    expect(sniffFileType(bytes(0x89, 0x50, 0x4e, 0x47))).toBe('png')
    expect(sniffFileType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg')
    expect(sniffFileType(bytes(0x49, 0x49, 0x2a, 0x00))).toBe('tiff')
    expect(sniffFileType(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('zip')
    expect(sniffFileType(text('<!DOCTYPE html><html><body>Sign in'))).toBe('html')
    expect(sniffFileType(text('{"error":"session expired"}'))).toBe('json')
    expect(sniffFileType(new Uint8Array())).toBe('empty')
    expect(sniffFileType(null)).toBe('empty')
    expect(sniffFileType(bytes(0x01, 0x02, 0x03, 0x04))).toBe('unknown')
  })
  it('does not call a PDF mentioned deep inside a big file a PDF', () => {
    // The header lives at the front. A 1 MB page that merely says "%PDF-" somewhere is not one.
    const big = padded(text('<html>'), 1_000_000)
    big.set(text('%PDF-'), 500_000)
    expect(sniffFileType(big)).toBe('html')
  })
})

describe('describeNotPdf', () => {
  it('says nothing about an actual PDF', () => {
    expect(describeNotPdf(text('%PDF-1.7'))).toBeNull()
  })
  it('names an expired portal session, which is the usual cause', () => {
    const msg = describeNotPdf(padded(text('<!DOCTYPE html><html>Login'), 4096))!
    expect(msg).toContain('web page')
    expect(msg).toContain('capture it again')
  })
  it('tells a scan apart, because that one has to be done by hand', () => {
    const msg = describeNotPdf(padded(bytes(0x89, 0x50, 0x4e, 0x47), 2048))!
    expect(msg).toContain('PNG image')
    expect(msg).toContain('by hand')
  })
  it('covers the empty download and the one nobody recognises', () => {
    expect(describeNotPdf(new Uint8Array())).toContain('empty')
    const msg = describeNotPdf(bytes(0x01, 0x02, 0x03))!
    expect(msg).toContain('not a PDF')
    expect(msg).toContain('01 02 03')
  })
})

describe('previewBytes', () => {
  it('shows text as text and binary as hex', () => {
    expect(previewBytes(text('%PDF-1.7'))).toBe('"%PDF-1.7"')
    expect(previewBytes(bytes(0x89, 0x50))).toBe('89 50')
    expect(previewBytes(new Uint8Array())).toBe('nothing')
  })
})
