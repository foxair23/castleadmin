// What happens after each signature lands. Kept out of the route so the next chunks can
// grow it without touching the API: after the customer signs, the technician is told
// (chunk 5); after the technician signs, the completed PDF is produced, sent to the
// customer, filed on the SF job and flagged for the portal (chunk 6). Until those land
// these are the hook points and only log.

export async function afterCustomerSigned(docId: string): Promise<void> {
  console.log(`[esign] customer signed ${docId} — tech notification lands in chunk 5`)
}

export async function afterTechSigned(docId: string): Promise<void> {
  console.log(`[esign] tech signed ${docId} — finalize lands in chunk 6`)
}
