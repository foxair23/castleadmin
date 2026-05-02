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

  const { data: submission } = await supabase
    .from('week_submissions')
    .select('id, admin_unlocked')
    .eq('tech_id', user.id)
    .eq('week_start_date', weekStart)
    .maybeSingle()

  if (isDeadlinePassed(weekStart) && !submission?.admin_unlocked) {
    redirect(`/tech?week=${weekStart}`)
  }

  // Load active job types
  const { data: jobTypes } = await supabase
    .from('job_types')
    .select('id, name, base_rate, additional_rate, requires_quantity')
    .eq('is_active', true)
    .order('name')

  return (
    <JobForm
      mode="new"
      weekStart={weekStart}
      userId={user.id}
      jobTypes={jobTypes ?? []}
    />
  )
}
