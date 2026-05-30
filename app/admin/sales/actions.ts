'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()
  if (!profile?.is_active || profile.role !== 'admin') redirect('/login')
  return user.id
}

function db() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export async function toggleCampaignTracked(mailchimpCampaignId: string, isTracked: boolean) {
  await requireAdmin()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db() as any)
    .from('mc_campaigns')
    .update({ is_tracked: isTracked })
    .eq('mailchimp_campaign_id', mailchimpCampaignId)
  revalidatePath('/admin/sales')
}

export async function toggleCampaignOpenersOnly(mailchimpCampaignId: string, openersOnly: boolean) {
  await requireAdmin()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db() as any)
    .from('mc_campaigns')
    .update({ openers_only: openersOnly })
    .eq('mailchimp_campaign_id', mailchimpCampaignId)
  revalidatePath('/admin/sales')
}

export async function saveCampaignAssignment(campaignId: string, userId: string | null) {
  const adminId = await requireAdmin()
  const database = db()
  const now = new Date().toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (database as any)
    .from('mc_campaigns')
    .update({ assigned_to_user_id: userId })
    .eq('mailchimp_campaign_id', campaignId)

  if (userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count } = await (database as any)
      .from('sales_leads')
      .update({ assigned_to_user_id: userId, assigned_at: now, assigned_by_user_id: adminId })
      .eq('mailchimp_campaign_id', campaignId)
      .select('id', { count: 'exact', head: true })
    revalidatePath('/admin/sales')
    revalidatePath('/sales')
    return { assigned: count ?? 0 }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (database as any)
      .from('sales_leads')
      .update({ assigned_to_user_id: null, assigned_at: null, assigned_by_user_id: null })
      .eq('mailchimp_campaign_id', campaignId)
    revalidatePath('/admin/sales')
    revalidatePath('/sales')
    return { assigned: 0 }
  }
}

// ─── Pipeline statuses ────────────────────────────────────────────────────────

export async function addPipelineStatus(name: string) {
  await requireAdmin()
  const trimmed = name.trim()
  if (!trimmed) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (db() as any)
    .from('sales_pipeline_statuses')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .single()
  const nextOrder = ((existing as any)?.sort_order ?? 0) + 1
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db() as any).from('sales_pipeline_statuses').insert({ name: trimmed, sort_order: nextOrder })
  revalidatePath('/admin/sales')
}

export async function renamePipelineStatus(id: string, name: string) {
  await requireAdmin()
  const trimmed = name.trim()
  if (!trimmed) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db() as any).from('sales_pipeline_statuses').update({ name: trimmed }).eq('id', id)
  revalidatePath('/admin/sales')
}

export async function deletePipelineStatus(id: string) {
  await requireAdmin()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db() as any).from('sales_pipeline_statuses').update({ is_active: false }).eq('id', id)
  revalidatePath('/admin/sales')
}

export async function movePipelineStatus(id: string, direction: 'up' | 'down') {
  await requireAdmin()
  const database = db()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: all } = await (database as any)
    .from('sales_pipeline_statuses')
    .select('id, sort_order')
    .eq('is_active', true)
    .order('sort_order')

  const items = (all ?? []) as { id: string; sort_order: number }[]
  const idx = items.findIndex(i => i.id === id)
  if (idx < 0) return
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= items.length) return

  const [a, b] = [items[idx], items[swapIdx]]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await Promise.all([
    (database as any).from('sales_pipeline_statuses').update({ sort_order: b.sort_order }).eq('id', a.id),
    (database as any).from('sales_pipeline_statuses').update({ sort_order: a.sort_order }).eq('id', b.id),
  ])
  revalidatePath('/admin/sales')
}

// ─── Call dispositions ────────────────────────────────────────────────────────

export async function addCallDisposition(name: string) {
  await requireAdmin()
  const trimmed = name.trim()
  if (!trimmed) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (db() as any)
    .from('sales_call_dispositions')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .single()
  const nextOrder = ((existing as any)?.sort_order ?? 0) + 1
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db() as any).from('sales_call_dispositions').insert({ name: trimmed, sort_order: nextOrder })
  revalidatePath('/admin/sales')
}

export async function renameCallDisposition(id: string, name: string) {
  await requireAdmin()
  const trimmed = name.trim()
  if (!trimmed) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db() as any).from('sales_call_dispositions').update({ name: trimmed }).eq('id', id)
  revalidatePath('/admin/sales')
}

export async function deleteCallDisposition(id: string) {
  await requireAdmin()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db() as any).from('sales_call_dispositions').update({ is_active: false }).eq('id', id)
  revalidatePath('/admin/sales')
}

// ─── Unmatched engagements ────────────────────────────────────────────────────

export async function linkEngagementToCustomer(engagementId: string, customerId: string) {
  await requireAdmin()
  const database = db()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (database as any)
    .from('mc_campaign_engagement')
    .update({ customer_id: customerId })
    .eq('id', engagementId)

  // Also create a sales_lead if there is a tracked campaign and none exists yet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: eng } = await (database as any)
    .from('mc_campaign_engagement')
    .select('mailchimp_campaign_id, open_count, click_count, first_opened_at, last_opened_at')
    .eq('id', engagementId)
    .single()

  if (eng) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: campaign } = await (database as any)
      .from('mc_campaigns')
      .select('tag_name, is_tracked')
      .eq('mailchimp_campaign_id', (eng as any).mailchimp_campaign_id)
      .single()

    if ((campaign as any)?.is_tracked) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (database as any)
        .from('sales_leads')
        .upsert(
          {
            customer_id: customerId,
            mailchimp_campaign_id: (eng as any).mailchimp_campaign_id,
            tag_name: (campaign as any).tag_name,
            status: 'New',
            open_count: (eng as any).open_count,
            click_count: (eng as any).click_count,
            first_opened_at: (eng as any).first_opened_at,
            last_opened_at: (eng as any).last_opened_at,
            last_activity_at: (eng as any).last_opened_at ?? new Date().toISOString(),
          },
          { onConflict: 'customer_id,mailchimp_campaign_id', ignoreDuplicates: true }
        )
    }
  }

  revalidatePath('/admin/sales')
  revalidatePath('/sales')
}

export async function dismissEngagement(engagementId: string) {
  await requireAdmin()
  // We mark it as "matched" to a sentinel to hide it from the unmatched panel.
  // Simpler than adding a dismissed column: we just set customer_id to a non-null
  // value that won't match any real customer. Instead, we'll add a dismissed flag
  // via a null-safe pattern: set customer_id to empty string to signal dismissed.
  // Actually cleanest: just delete it from the engagement table.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db() as any).from('mc_campaign_engagement').delete().eq('id', engagementId)
  revalidatePath('/admin/sales')
}

// ─── Tag assignments ──────────────────────────────────────────────────────────

// Upsert or delete a standing tag → rep assignment rule.
// Passing userId=null removes the rule (future leads won't auto-assign);
// existing leads keep their current assignment.
// When a rep is chosen, the rule is saved AND every existing lead carrying
// that tag is (re)assigned to the rep immediately — this is the sole
// assignment mechanism, so "this tag belongs to this rep" must apply to
// leads that already exist, not just future syncs.
export async function saveTagAssignment(tagName: string, userId: string | null) {
  const adminId = await requireAdmin()
  const database = db()
  const now = new Date().toISOString()

  if (!userId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (database as any).from('mc_tag_assignments').delete().eq('tag_name', tagName)
    revalidatePath('/admin/sales')
    revalidatePath('/sales')
    return { assigned: 0 }
  }

  // Save the standing rule (used to auto-assign future synced leads)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (database as any)
    .from('mc_tag_assignments')
    .upsert(
      { tag_name: tagName, assigned_to_user_id: userId, assigned_by_user_id: adminId, updated_at: now },
      { onConflict: 'tag_name' }
    )

  // Retroactively (re)assign every existing lead carrying this tag to the rep.
  // Includes currently-unassigned leads; re-stamping an already-correct lead is harmless.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: leads } = await (database as any)
    .from('sales_leads')
    .select('id')
    .eq('tag_name', tagName)

  const ids = ((leads ?? []) as { id: string }[]).map(l => l.id)
  if (ids.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (database as any)
      .from('sales_leads')
      .update({ assigned_to_user_id: userId, assigned_at: now, assigned_by_user_id: adminId })
      .in('id', ids)
  }

  revalidatePath('/admin/sales')
  revalidatePath('/sales')
  return { assigned: ids.length }
}

export async function searchCustomers(query: string) {
  await requireAdmin()
  const q = query.trim()
  if (q.length < 2) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db() as any)
    .from('sf_customers')
    .select('id, customer_name, account_number')
    .or(`customer_name.ilike.%${q}%,account_number.ilike.%${q}%`)
    .eq('is_deleted', false)
    .limit(10)
  return (data ?? []) as { id: string; customer_name: string | null; account_number: string | null }[]
}
