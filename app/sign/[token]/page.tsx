import { notFound } from 'next/navigation'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { signedUrl } from '@/lib/vendor-orders/attachments'
import { templateByKey } from '@/lib/esign/templates'
import { scopeForToken, signState } from '@/lib/esign/transitions'
import SignClient from './SignClient'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Review & e-sign — Castle Garage Doors & Gates' }

// Public, no-login signing page. One document has two links: the customer's and the
// technician's. The unguessable token in the path is the authorization; the page works
// out whose it is and what state the document is in. Never locked by date.
export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) notFound()
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: doc } = await db.from('esign_documents')
    .select('id, order_id, status, template_key, customer_token, tech_token, prepared_pdf_path, completed_pdf_path, prefill, customer_signed_at, customer_signed_name, tech_signed_at, tech_signed_name')
    .or(`customer_token.eq.${token},tech_token.eq.${token}`).maybeSingle()
  if (!doc) notFound()
  const scope = scopeForToken(doc, token)
  if (!scope) notFound()
  const state = signState(doc, scope)
  const template = templateByKey(doc.template_key as string | null)
  const pdfPath = (doc.completed_pdf_path as string | null) ?? (doc.prepared_pdf_path as string | null)
  const pdfUrl = pdfPath ? await signedUrl(pdfPath, 3600) : null
  const prefill = (doc.prefill ?? {}) as Record<string, string>
  const inputs = (template?.fields ?? []).filter(f => f.kind === 'customer_input').map(f => ({ key: f.key, label: f.label ?? f.key, required: !!f.required }))

  return (
    <SignClient
      token={token}
      scope={scope}
      state={state}
      service={template?.service ?? 'install'}
      pdfUrl={pdfUrl}
      customerName={prefill.customer_name ?? null}
      address={prefill.address_full ?? null}
      jobNumber={prefill.sf_job_number ?? null}
      inputs={scope === 'customer' ? inputs : []}
      signedName={scope === 'customer' ? (doc.customer_signed_name as string | null) : (doc.tech_signed_name as string | null)}
      signedAt={scope === 'customer' ? (doc.customer_signed_at as string | null) : (doc.tech_signed_at as string | null)}
      customerSignedAt={doc.customer_signed_at as string | null}
    />
  )
}
