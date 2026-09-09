// What happens after each signature lands, off the request path (the route wraps these in
// after()). The hourly sweep repeats both, so a failure here is a delay, not a loss.

export async function afterCustomerSigned(docId: string): Promise<void> {
  const { notifyTech } = await import('./tech')
  const r = await notifyTech(docId)
  if (!r.ok) console.warn(`[esign] tech not notified for ${docId}: ${r.error}`)
}

export async function afterTechSigned(docId: string): Promise<void> {
  const { finalizeEsignDoc } = await import('./finalize')
  const r = await finalizeEsignDoc(docId)
  if (!r.ok) console.error(`[esign] finalize failed for ${docId}: ${r.error}`)
}
