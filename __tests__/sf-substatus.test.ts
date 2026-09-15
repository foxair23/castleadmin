import { describe, it, expect } from 'vitest'
import { parseSubStatusOptions, pickSubStatusId, subStatusFromResponse, nameKey } from '../chrome-extension/sf-remittance/sf-substatus.js'

// Captured from a real job on 2026-09-15 — the popover Service Fusion returns for
// POST /jobs/showSubStatusPopover. Kept verbatim so a change on SF's side fails here first.
const POPOVER = `
<span class="status-as-of"><b>Set To</b>
		<select id="jobSubStatusId" class="select-job select2-select-00" style="margin-left:7px;">
		<option value="0">-No Sub-Status-</option>
					<option value="1018762242">Waiting for Customer</option>
					<option value="1018762754">Sales Call</option>
					<option value="1018762756">site check sent</option>
					<option value="1018762833">waiting on HD</option>
					<option value="1018900888">HD SOF Needed</option>
					<option value="1018900890">HD SOF Sent</option>
					<option value="1018900891">HD SOF Complete</option>
					<option value="1018763450">Archived</option>
				</select>
		</span>
		<span> <input type="button" onclick="changeJobSubStatus('hrX6aeC9QBOLOfG6rjheGOpQwEEaeAoXYdanN1jjiAk')" class="btn btn-success" value="Save Status Change">
		</span>`

describe('parseSubStatusOptions', () => {
  it('reads every sub-status SF offers, with its id', () => {
    const options = parseSubStatusOptions(POPOVER)
    expect(options).toHaveLength(9)
    expect(options[0]).toEqual({ id: '0', name: '-No Sub-Status-' })
    expect(options.find((o: { name: string }) => o.name === 'HD SOF Needed')).toEqual({ id: '1018900888', name: 'HD SOF Needed' })
    expect(options.find((o: { name: string }) => o.name === 'HD SOF Sent')).toEqual({ id: '1018900890', name: 'HD SOF Sent' })
    expect(options.find((o: { name: string }) => o.name === 'HD SOF Complete')).toEqual({ id: '1018900891', name: 'HD SOF Complete' })
  })
  it('gives nothing rather than guessing when the page is not the popover', () => {
    expect(parseSubStatusOptions('<html>login</html>')).toEqual([])
    expect(parseSubStatusOptions('')).toEqual([])
  })
})

describe('pickSubStatusId', () => {
  const options = parseSubStatusOptions(POPOVER)
  // Matched by NAME at run time: the office can rebuild a sub-status in SF settings, which
  // changes its id, and a hardcoded id would then write the wrong label onto a job.
  it('finds a sub-status however it was typed', () => {
    expect(pickSubStatusId(options, 'HD SOF Sent')).toBe('1018900890')
    expect(pickSubStatusId(options, '  hd sof   sent ')).toBe('1018900890')
  })
  it('returns null for one SF does not have, so the caller can say so', () => {
    expect(pickSubStatusId(options, 'HD SOF Pending')).toBeNull()   // the name before the office renamed it
    expect(pickSubStatusId(options, '')).toBeNull()
    expect(pickSubStatusId([], 'HD SOF Sent')).toBeNull()
  })
  it('does not half-match a longer name', () => {
    expect(pickSubStatusId(options, 'HD SOF')).toBeNull()
  })
})

describe('subStatusFromResponse', () => {
  // SF echoes the NEW value (verified against all three), so this is the write's receipt.
  it('reads what SF says the job now holds', () => {
    expect(subStatusFromResponse('{"color":"#f2fa0a","subStatus":"HD SOF Sent"}')).toEqual({ name: 'HD SOF Sent', color: '#f2fa0a' })
    expect(subStatusFromResponse('{"color":"#6ae342","subStatus":"HD SOF Complete"}')).toEqual({ name: 'HD SOF Complete', color: '#6ae342' })
  })
  it('is null on anything that is not that, so a write is never called done on a guess', () => {
    expect(subStatusFromResponse('<html>login page</html>')).toBeNull()
    expect(subStatusFromResponse('{"error":"nope"}')).toBeNull()
    expect(subStatusFromResponse('')).toBeNull()
  })
})

describe('nameKey', () => {
  it('decodes entities and flattens whitespace', () => {
    expect(nameKey('Bill &amp;  Hold')).toBe('bill & hold')
    expect(nameKey(null)).toBe('')
  })
})
