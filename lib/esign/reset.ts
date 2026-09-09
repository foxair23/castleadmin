import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Undo a signature. A test sign, a customer who signed the wrong house, a tech who signed
// before the customer — the office can wipe it from the Signatures page and the link works
// again. Resetting the CUSTOMER's signature also clears the technician's (the tech signs
// after the customer, on top of the customer's copy). Refused once the completed form has
// been filed on the SF job or the portal: at that point the paper trail is outside us.

const BUCKET = 'vendor-order-attachments'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const CUSTOMER_CLEAR = { customer_signed_at: null, customer_signed_name: null, customer_ip: null, customer_user_agent: null, customer_sig_path: null, customer_fields: null }
const TECH_CLEAR = { tech_signed_at: null, tech_signed_name: null, tech_ip: null, tech_user_agent: null, tech_sig_path: null, tech_sent_at: null, tech_sent_channels: null, tech_reminded_at: null }
const FINAL_CLEAR = { completed_pdf_path: null, completed_at: null }

export async function resetSignature(docId: string, scope: 'customer' | 'tech', byName: string | null): Promise<{ ok: boolean; status?: string; error?: string }> {
  const supabase = db()
  const { data: doc } = await supabase.from('esign_documents')
    .select('id, order_id, status, customer_sent_at, customer_signed_at, tech_signed_at, customer_sig_path, tech_sig_path, completed_pdf_path')
    .eq('id', docId).maybeSingle()
  if (!doc) return { ok: false, error: 'Document not found.' }
  if (['sf_uploaded', 'portal_uploaded'].includes(doc.status as string)) return { ok: false, error: 'This form has already been filed — it cannot be reset here.' }
  if (doc.status === 'cancelled') return { ok: false, error: 'This form is cancelled.' }
  if (scope === 'tech' && !doc.tech_signed_at) return { ok: false, error: 'The technician has not signed.' }
  if (scope === 'customer' && !doc.customer_signed_at) return { ok: false, error: 'The customer has not signed.' }

  const status = scope === 'customer' ? (doc.customer_sent_at ? 'sent_customer' : 'prepared') : 'customer_signed'
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString(), error: null, ...TECH_CLEAR, ...FINAL_CLEAR }
  if (scope === 'customer') Object.assign(patch, CUSTOMER_CLEAR)
  const { error } = await supabase.from('esign_documents').update(patch).eq('id', docId).eq('status', doc.status)
  if (error) return { ok: false, error: error.message }

  const gone = [scope === 'customer' ? doc.customer_sig_path : null, doc.tech_sig_path, doc.completed_pdf_path].filter((p): p is string => !!p)
  if (gone.length) { try { await supabase.storage.from(BUCKET).remove(gone) } catch { /* orphaned files are harmless */ } }
  await supabase.from('vendor_order_events').insert({ order_id: doc.order_id, event_type: `esign_${scope}_signature_reset`, to_value: status, detail: { doc_id: docId, by: byName, from_status: doc.status } })
  return { ok: true, status }
}
