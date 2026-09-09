import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { signedUrls } from '@/lib/vendor-orders/attachments'
import { TEMPLATES } from '@/lib/esign/templates'
import { getEsignSettings } from '@/lib/esign/settings'
import { appUrl } from '@/lib/config/domains'
import HdOrdersNav from '../HdOrdersNav'
import SignaturesClient, { type EsignRow, type FingerprintRow, type SignedSample } from './SignaturesClient'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'HD Orders — Signatures' }

// Every e-sign document by stage, and every blank-form VERSION seen so far — registered or
// not — so a layout can be pinned from a real document. Admin-only.
export default async function SignaturesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/admin/vendor-orders')

  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const settings = await getEsignSettings('clopay_hd', 'lien_waiver')
  const { data: docs } = await db.from('esign_documents')
    .select('id, order_id, vendor, doc_type, status, template_key, template_fingerprint, source_attachment_id, sf_job_id, customer_sent_at, customer_asked_at, customer_signed_at, tech_name, tech_sent_at, tech_signed_at, completed_at, sf_uploaded_at, portal_uploaded_at, portal_uploaded_by, prepared_pdf_path, completed_pdf_path, error, created_at, customer_token, tech_token')
    .order('created_at', { ascending: false }).limit(500)
  const orderIds = [...new Set((docs ?? []).map(d => d.order_id as string))]
  const { data: orders } = orderIds.length ? await db.from('vendor_orders').select('id, external_id, customer_name, sf_created_job_number, status').in('id', orderIds) : { data: [] }
  const orderById = new Map((orders ?? []).map(o => [o.id as string, o]))
  const jobIds = [...new Set((docs ?? []).map(d => d.sf_job_id as string | null).filter(Boolean) as string[])]
  const { data: jobs } = jobIds.length ? await db.from('sf_jobs').select('id, number, start_date').in('id', jobIds) : { data: [] }
  const jobById = new Map((jobs ?? []).map(j => [j.id as string, j]))

  const rows: EsignRow[] = (docs ?? []).map(d => {
    const o = orderById.get(d.order_id as string)
    const j = jobById.get((d.sf_job_id as string | null) ?? '')
    return {
      id: d.id as string, order_id: d.order_id as string, status: d.status as string, template_key: d.template_key as string | null,
      template_fingerprint: d.template_fingerprint as string | null, external_id: (o?.external_id as string | null) ?? null,
      customer_name: (o?.customer_name as string | null) ?? null, order_status: (o?.status as string | null) ?? null,
      sf_job_number: (j?.number as string | null) ?? (o?.sf_created_job_number as string | null) ?? null, start_date: (j?.start_date as string | null) ?? null,
      customer_sent_at: d.customer_sent_at as string | null, customer_asked_at: d.customer_asked_at as string | null, customer_signed_at: d.customer_signed_at as string | null,
      tech_name: d.tech_name as string | null, tech_sent_at: d.tech_sent_at as string | null, tech_signed_at: d.tech_signed_at as string | null,
      completed_at: d.completed_at as string | null, sf_uploaded_at: d.sf_uploaded_at as string | null, portal_uploaded_at: d.portal_uploaded_at as string | null,
      portal_uploaded_by: d.portal_uploaded_by as string | null, has_prepared: !!d.prepared_pdf_path, has_completed: !!d.completed_pdf_path,
      error: d.error as string | null, created_at: d.created_at as string,
      customer_link: `${appUrl()}/sign/${d.customer_token as string}`, tech_link: `${appUrl()}/sign/${d.tech_token as string}`,
    }
  })

  // Form versions: every fingerprint seen, how many blanks carry it, whether a layout is pinned.
  const byFp = new Map<string, FingerprintRow>()
  for (const r of rows) {
    if (!r.template_fingerprint) continue
    const e = byFp.get(r.template_fingerprint) ?? { fingerprint: r.template_fingerprint, count: 0, template_key: null, sample_doc_id: r.id, sample_external_id: r.external_id }
    e.count++
    if (r.template_key) e.template_key = r.template_key
    byFp.set(r.template_fingerprint, e)
  }
  const registered = new Set(TEMPLATES.flatMap(t => t.fingerprints))
  const fingerprints = [...byFp.values()].map(f => ({ ...f, template_key: f.template_key ?? (registered.has(f.fingerprint) ? TEMPLATES.find(t => t.fingerprints.includes(f.fingerprint))!.key : null) })).sort((a, b) => b.count - a.count)
  // (A version pinned by its footer marker shows as pinned once any of its blanks has been
  //  prepared — template_key on the row — which "Prepare pending" does.)
  const uninspected = rows.filter(r => r.status === 'found').length

  // A few signed forms that came back from the portal — the layout reference for signature and date boxes.
  const { data: signedAtts } = await db.from('vendor_order_attachments').select('id, order_id, storage_path, raw_name, created_at').eq('esign_doc_type', 'lien_waiver_signed').order('created_at', { ascending: false }).limit(6)
  const signedUrlMap = await signedUrls((signedAtts ?? []).map(a => a.storage_path as string))
  const sampleOrderIds = [...new Set((signedAtts ?? []).map(a => a.order_id as string))]
  const { data: sampleOrders } = sampleOrderIds.length ? await db.from('vendor_orders').select('id, external_id').in('id', sampleOrderIds) : { data: [] }
  const extById = new Map((sampleOrders ?? []).map(o => [o.id as string, o.external_id as string | null]))
  const signedSamples: SignedSample[] = (signedAtts ?? []).map(a => ({ id: a.id as string, external_id: extById.get(a.order_id as string) ?? null, url: signedUrlMap.get(a.storage_path as string) ?? null, created_at: a.created_at as string }))

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <HdOrdersNav base="/admin/vendor-orders" />
      <SignaturesClient rows={rows} fingerprints={fingerprints} uninspected={uninspected} signedSamples={signedSamples} registeredCount={TEMPLATES.length} settings={settings} />
    </div>
  )
}
