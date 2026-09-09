'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { prepareEsignDoc, preparePendingEsignDocs, inspectEsignDoc } from '@/lib/esign/prepare'
import { classifyPendingAttachments } from '@/lib/esign/backfill'

// Signatures page actions. Admin-only: this is where form layouts get pinned and the
// pipeline nudged along by hand — nothing customer-facing lives here.
async function assertAdmin(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data: profile } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  return !!profile?.is_active && profile.role === 'admin'
}

const PATH = '/admin/vendor-orders/signatures'

export async function prepareEsignDocAction(id: string): Promise<{ ok: boolean; status?: string; fingerprint?: string; template?: string | null; error?: string }> {
  if (!(await assertAdmin())) return { ok: false, error: 'admin only' }
  const r = await prepareEsignDoc(id)
  revalidatePath(PATH)
  return r
}

export async function runPrepareSweepAction(): Promise<{ ok: boolean; looked?: number; prepared?: number; unrecognised?: number; failed?: number; error?: string }> {
  if (!(await assertAdmin())) return { ok: false, error: 'admin only' }
  const r = await preparePendingEsignDocs(50)
  revalidatePath(PATH)
  return { ok: true, ...r }
}

export async function classifyBacklogAction(): Promise<{ ok: boolean; looked?: number; lien_waiver?: number; signed?: number; none?: number; remaining?: number; error?: string }> {
  if (!(await assertAdmin())) return { ok: false, error: 'admin only' }
  const r = await classifyPendingAttachments(200)
  revalidatePath(PATH)
  return { ok: true, ...r }
}

export async function inspectEsignDocAction(id: string): Promise<{ ok: boolean; fingerprint?: string; template?: string | null; pageCount?: number; pageSizes?: Array<{ w: number; h: number }>; acroFields?: Array<{ name: string; type: string }>; firstPageText?: string; error?: string }> {
  if (!(await assertAdmin())) return { ok: false, error: 'admin only' }
  const r = await inspectEsignDoc(id)
  if (!r.ok || !r.inspection) return { ok: false, error: r.error ?? 'inspect failed' }
  return { ok: true, fingerprint: r.fingerprint, template: r.template?.key ?? null, pageCount: r.inspection.pageCount, pageSizes: r.inspection.pageSizes, acroFields: r.inspection.acroFields, firstPageText: r.inspection.firstPageText.slice(0, 3000) }
}
