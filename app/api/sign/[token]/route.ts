import { NextRequest, NextResponse, after } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { scopeForToken, signState, statusAfterSign, decodeDataUrlPng } from '@/lib/esign/transitions'
import { afterCustomerSigned, afterTechSigned } from '@/lib/esign/after-sign'

const BUCKET = 'vendor-order-attachments'

function db() {
  return createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

// POST — a signature lands. The token says whose. Body: { typed_name, agree, signature_png
// (data URL), fields? }. The PNG is stored, then the status moves by a CONDITIONAL update
// on the current status, so a double-submit or a shared link cannot record two signatures.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 })
  let body: { typed_name?: string; agree?: boolean; signature_png?: string; fields?: Record<string, string> }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (body.agree !== true) return NextResponse.json({ error: 'Please check the agreement box.' }, { status: 400 })
  const typedName = (body.typed_name ?? '').trim()
  if (typedName.length < 2 || typedName.length > 120) return NextResponse.json({ error: 'Type your full name.' }, { status: 400 })
  const png = body.signature_png ? decodeDataUrlPng(body.signature_png) : null
  if (!png) return NextResponse.json({ error: 'Please draw your signature.' }, { status: 400 })

  const supabase = db()
  const { data: doc } = await supabase.from('esign_documents')
    .select('id, order_id, status, customer_token, tech_token, customer_signed_at, tech_signed_at')
    .or(`customer_token.eq.${token},tech_token.eq.${token}`).maybeSingle()
  if (!doc) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 })
  const scope = scopeForToken(doc, token)
  if (!scope) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 })
  const state = signState(doc, scope)
  if (state === 'already_signed') return NextResponse.json({ error: 'This form has already been signed.' }, { status: 409 })
  if (state !== 'ready') return NextResponse.json({ error: scope === 'tech' && state === 'waiting_customer' ? 'The customer has not signed yet.' : 'This form is not ready to sign.' }, { status: 409 })
  const next = statusAfterSign(scope, doc.status as string)
  if (!next) return NextResponse.json({ error: 'This form is not ready to sign.' }, { status: 409 })

  const sigPath = `${doc.order_id}/esign/${doc.id}/${scope}-sig.png`
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(sigPath, png, { contentType: 'image/png', upsert: true })
  if (upErr) return NextResponse.json({ error: 'Could not save the signature. Please try again.' }, { status: 500 })

  const now = new Date().toISOString()
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || null
  const ua = req.headers.get('user-agent')?.slice(0, 500) || null
  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(body.fields ?? {})) if (typeof v === 'string' && /^[a-z0-9_]{1,40}$/i.test(k)) fields[k] = v.slice(0, 500)
  const patch = scope === 'customer'
    ? { status: next, customer_signed_at: now, customer_signed_name: typedName, customer_ip: ip, customer_user_agent: ua, customer_sig_path: sigPath, customer_fields: fields, updated_at: now }
    : { status: next, tech_signed_at: now, tech_signed_name: typedName, tech_ip: ip, tech_user_agent: ua, tech_sig_path: sigPath, updated_at: now }
  const { data: stamped } = await supabase.from('esign_documents').update(patch).eq('id', doc.id).eq('status', doc.status).select('id')
  if (!stamped?.length) return NextResponse.json({ error: 'This form has already been signed.' }, { status: 409 })
  await supabase.from('vendor_order_events').insert({ order_id: doc.order_id, event_type: `esign_${scope}_signed`, to_value: typedName, detail: { doc_id: doc.id, ip } })

  after(async () => { try { await (scope === 'customer' ? afterCustomerSigned(doc.id) : afterTechSigned(doc.id)) } catch (e) { console.error('[esign] after-sign', e) } })
  return NextResponse.json({ ok: true, signed_at: now })
}
