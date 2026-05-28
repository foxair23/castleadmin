import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getWeekStart, isDeadlinePassed } from '@/lib/week'
import JobForm from '../JobForm'

export default async function NewJobPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const weekStart = params.week ?? getWeekStart()

  const [{ data: submission }, { data: profile }, { data: jobTypes }] = await Promise.all([
    supabase
      .from('week_submissions')
      .select('id, admin_unlocked')
      .eq('tech_id', user.id)
      .eq('week_start_date', weekStart)
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('gas_eligible')
      .eq('id', user.id)
      .single(),
    supabase
      .from('job_types')
      .select('id, name, base_rate, additional_rate, requires_quantity, requires_sale_amount')
      .eq('is_active', true)
      .order('name'),
  ])

  if (isDeadlinePassed(weekStart) && !submission?.admin_unlocked) {
    redirect(`/tech?week=${weekStart}`)
  }

  return (
    <JobForm
      mode="new"
      weekStart={weekStart}
      userId={user.id}
      jobTypes={jobTypes ?? []}
      gasEligible={profile?.gas_eligible ?? false}
    />
  )
}
