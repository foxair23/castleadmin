import { createClient as createAdminClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/notifications/resend'
import { renderCommissionPromptEmail } from '@/lib/notifications/templates/commission'
import { planFingerprint, type PlanTerms } from './acceptance'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://castleadmin.vercel.app'

export interface AffectedPlan {
  tech_user_id: string
  period_start: string
  period_end: string
}

// After an admin saves/copies plans, email each affected tech a prompt to accept
// — but only when the plan is currently unaccepted AND we haven't already
// prompted for this exact fingerprint (dedupe via acceptance_prompt_fingerprint).
// Best-effort: never throws (each tech isolated), so it can't fail the save.
// Uses a dedicated service-role client (no user session) so auth.admin works.
export async function sendAcceptancePrompts(affected: AffectedPlan[]): Promise<void> {
  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  // De-dup the input by tech+period.
  const seen = new Set<string>()
  const unique = affected.filter(a => {
    const k = `${a.tech_user_id}|${a.period_start}|${a.period_end}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  for (const a of unique) {
    try {
      const { data: plan } = await db
        .from('commission_plans')
        .select('id, sales_target, rate_below, rate_above, period_start, period_end, acceptance_prompt_fingerprint')
        .eq('tech_user_id', a.tech_user_id)
        .eq('period_start', a.period_start)
        .eq('period_end', a.period_end)
        .maybeSingle()
      if (!plan) continue

      const terms: PlanTerms = {
        sales_target: Number(plan.sales_target),
        rate_below: Number(plan.rate_below),
        rate_above: Number(plan.rate_above),
        period_start: plan.period_start,
        period_end: plan.period_end,
      }
      const fp = planFingerprint(terms)

      // Already accepted at this fingerprint? Then no prompt needed.
      const { data: acc } = await db
        .from('commission_plan_acceptances')
        .select('terms_fingerprint')
        .eq('plan_id', plan.id)
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (acc?.terms_fingerprint === fp) continue

      // Already prompted for this exact fingerprint? Don't re-spam.
      if (plan.acceptance_prompt_fingerprint === fp) continue

      // Resolve the tech's email + name.
      const [{ data: authUser }, { data: profile }] = await Promise.all([
        db.auth.admin.getUserById(a.tech_user_id),
        db.from('profiles').select('full_name').eq('id', a.tech_user_id).maybeSingle(),
      ])
      const email = authUser?.user?.email
      if (!email) continue

      const { subject, html, text } = renderCommissionPromptEmail({
        terms,
        techName: profile?.full_name ?? '',
        appUrl: APP_URL,
      })
      await sendEmail({ to: email, subject, html, text })

      // Mark prompted so repeat saves at the same terms don't re-send.
      await db.from('commission_plans').update({ acceptance_prompt_fingerprint: fp }).eq('id', plan.id)
    } catch (e) {
      console.error('[commission] acceptance prompt failed for', a.tech_user_id, e)
    }
  }
}
