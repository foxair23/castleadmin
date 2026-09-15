// What a stored "document" actually is.
//
// The blanks come from the Clopay portal via the extension, and not everything that lands in
// storage is the PDF we asked for: a portal session that has expired answers with an HTML
// login page, some documents are image scans, and a capture that goes wrong can leave a file
// of nothing but zero bytes. Feeding any of those to the PDF parser produces "No PDF header
// found (line:0 col:2560000 offset=1280000)", which tells the office nothing and looks like
// the feature is broken rather than the file being wrong.
//
// So sniff the magic bytes, say in words what the file is, and — the part that matters most —
// refuse to store one that is already known to be broken (see storeVendorDoc).

export type SniffedType = 'pdf' | 'png' | 'jpeg' | 'gif' | 'tiff' | 'zip' | 'html' | 'json' | 'empty' | 'zeros' | 'unknown'

const ascii = (b: Uint8Array, from: number, len: number): string =>
  String.fromCharCode(...b.slice(from, from + len))

const startsWith = (b: Uint8Array, sig: number[], at = 0): boolean =>
  sig.every((v, i) => b[at + i] === v)

/** What this file is, from its first bytes. Never throws. */
export function sniffFileType(bytes: Uint8Array | null | undefined): SniffedType {
  const b = bytes ?? new Uint8Array()
  if (b.length === 0) return 'empty'
  // Nothing but zeros is not a file format, it is a capture that never delivered. Seen on
  // two Clopay blanks, both exactly 1,280,000 bytes of them.
  if (b.slice(0, Math.min(b.length, 512)).every(v => v === 0)) return 'zeros'
  // A PDF may carry a byte-order mark or stray whitespace before the header; real readers
  // tolerate a short run of junk, so look for %PDF- in the first 1 KB rather than at 0.
  const head = ascii(b, 0, Math.min(b.length, 1024))
  if (head.includes('%PDF-')) return 'pdf'
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'png'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return 'gif'
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff'
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'zip'
  const trimmed = head.replace(/^[\s﻿]+/, '').toLowerCase()
  if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.startsWith('<?xml') || trimmed.startsWith('<head')) return 'html'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  return 'unknown'
}

const KB = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`

/** Null when the bytes are a PDF; otherwise a sentence the office can act on. */
export function describeNotPdf(bytes: Uint8Array | null | undefined): string | null {
  const kind = sniffFileType(bytes)
  if (kind === 'pdf') return null
  const size = KB(bytes?.length ?? 0)
  switch (kind) {
    case 'empty':
      return 'the stored file is empty — the portal download did not finish, so capture it again'
    case 'zeros':
      return `the stored file is ${size} of empty bytes — the portal download started but never delivered, so capture it again`
    case 'html':
      return `the stored file is a web page, not a PDF (${size}) — the Clopay session had almost certainly expired when it was captured, so sign in and capture it again`
    case 'json':
      return `the stored file is a portal error message, not a PDF (${size}) — capture it again`
    case 'png': case 'jpeg': case 'gif': case 'tiff':
      return `the stored file is ${kind === 'jpeg' ? 'a JPEG' : `a ${kind.toUpperCase()}`} image, not a PDF (${size}) — this document was scanned rather than generated, so it has to be filled in by hand`
    case 'zip':
      return `the stored file is a zip archive, not a PDF (${size}) — the portal may have bundled several documents together`
    default:
      return `the stored file is not a PDF (${size}, starts with ${previewBytes(bytes)}) — capture it again, or file this one by hand`
  }
}

/** The first few bytes as something printable, for an error a person will read. */
export function previewBytes(bytes: Uint8Array | null | undefined, n = 8): string {
  const b = (bytes ?? new Uint8Array()).slice(0, n)
  if (!b.length) return 'nothing'
  const printable = Array.from(b).every(c => c >= 0x20 && c < 0x7f)
  return printable ? `"${ascii(b, 0, b.length)}"` : Array.from(b).map(c => c.toString(16).padStart(2, '0')).join(' ')
}
