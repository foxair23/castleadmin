// Which vendor documents are e-sign documents, and which kind.
//
// Pinned from what Clopay actually puts on file (Sept 2026): the blank lien waiver arrives
// with docType "Blank ICA/LW" and the signed one comes back as "Signed ICA/LW". Names are
// either "LW_<n>_<n>" or a portal URL ending in "/installerdocuments/document/LW/<incident>-<po>".
// The stored filename is made filesystem-safe on the way in, which turns that URL into
// "https___hdprogramapi..._document_LW_..." — so classification uses Clopay's docType first
// and the RAW portal name as the fallback when the type is missing (6 documents on file).
// The name rule happens to survive the mangling too ("_LW_"), which is welcome, not relied on.
//
// Everything else — "New IPO" (handled by the IPO pipeline), "New SC", "HS-118/119/105",
// "New Srvc" (the SF&I form, phase 2), "New MC" — is 'none' here.

export type EsignDocKind = 'lien_waiver' | 'lien_waiver_signed' | 'none'

const LW_DOCTYPE_RE = /\bICA\s*\/\s*LW\b|lien\s*waiver/i
const LW_NAME_RE = /(^|[^A-Za-z])LW_|\/document\/LW\//i

export function isLienWaiverDoc(name: string | null | undefined, docType?: string | null): boolean {
  const t = (docType ?? '').trim()
  if (t) return LW_DOCTYPE_RE.test(t) && !/signed/i.test(t)
  return LW_NAME_RE.test(name ?? '')
}

export function isSignedLienWaiverDoc(name: string | null | undefined, docType?: string | null): boolean {
  const t = (docType ?? '').trim()
  return !!t && LW_DOCTYPE_RE.test(t) && /signed/i.test(t)
}

export function classifyVendorDoc(vendor: string, name: string | null | undefined, docType?: string | null): EsignDocKind {
  if (vendor !== 'clopay_hd') return 'none'
  if (isSignedLienWaiverDoc(name, docType)) return 'lien_waiver_signed'
  if (isLienWaiverDoc(name, docType)) return 'lien_waiver'
  return 'none'
}
