import { describe, it, expect } from 'vitest'
import { classifyVendorDoc, isLienWaiverDoc, isSignedLienWaiverDoc } from '@/lib/esign/classify'

// Pinned to the document types Clopay actually puts on file, not to guesses.
const URL_NAME = 'https://hdprogramapi.clopay.com/api/v1/installerdocuments/document/LW/181193546-46664198'
const MANGLED = 'https___hdprogramapi.clopay.com_api_v1_installerdocuments_document_LW_181193546-46664198'

describe('classifyVendorDoc', () => {
  it('finds the blank lien waiver by its Clopay docType, whatever the name looks like', () => {
    expect(classifyVendorDoc('clopay_hd', URL_NAME, 'Blank ICA/LW')).toBe('lien_waiver')
    expect(classifyVendorDoc('clopay_hd', 'LW_6786758_3672311', 'Blank ICA/LW')).toBe('lien_waiver')
    expect(classifyVendorDoc('clopay_hd', 'Document 12345', 'Blank ICA/LW')).toBe('lien_waiver')
  })
  it('tells the signed one that comes back from the portal apart from the blank', () => {
    expect(classifyVendorDoc('clopay_hd', 'https://orders.clopay.com/orders/CHUB/PROD/AUGUST2026/INBOUND/_4373183_082626180715.pdf', 'Signed ICA/LW')).toBe('lien_waiver_signed')
    expect(isSignedLienWaiverDoc('x', 'Signed ICA/LW')).toBe(true)
    expect(isLienWaiverDoc('x', 'Signed ICA/LW')).toBe(false)
  })
  it('leaves every other Clopay document alone', () => {
    for (const t of ['New IPO', 'New SC', 'Compltd SC', 'New HS-119', 'New HS-118', 'Compltd HS-118', 'New HS-105', 'New Srvc', 'New MC']) {
      expect(classifyVendorDoc('clopay_hd', 'anything', t)).toBe('none')
    }
    expect(classifyVendorDoc('clopay_hd', 'SF_6865362_3687243', 'New Srvc')).toBe('none')   // the SF&I form — phase 2
  })
  it('falls back to the raw portal name only when the docType is missing', () => {
    expect(classifyVendorDoc('clopay_hd', 'LW_6786758_3672311', null)).toBe('lien_waiver')
    expect(classifyVendorDoc('clopay_hd', URL_NAME, '')).toBe('lien_waiver')
    expect(classifyVendorDoc('clopay_hd', 'IP_123_456', null)).toBe('none')
  })
  it('still catches the filesystem-safe filename, as a last resort', () => {
    // The stored filename loses its slashes ("_document_LW_…"); the "_LW_" survives and the
    // boundary rule accepts it. raw_name remains the real signal — this is defence in depth.
    expect(classifyVendorDoc('clopay_hd', MANGLED, null)).toBe('lien_waiver')
    expect(classifyVendorDoc('clopay_hd', 'https___hdprogramapi.clopay.com_api_v1_installerdocuments_document_IPO_181193328-39975769', null)).toBe('none')
  })
  it('is Clopay-only for now', () => {
    expect(classifyVendorDoc('genie_thd', 'LW_1_2', 'Blank ICA/LW')).toBe('none')
  })
})
