import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getWeekStart, isDeadlinePassed } from '@/lib/week'
import BulkUpdateClient from './BulkUpdateClient'

export default async function BulkUpdatePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const selectedWeek = params.week ?? getWeekStart()

  const [{ data: jobs }, { data: jobTypes }, { data: submission }] = await Promise.all([
    supabase
      .from('jobs')
      .select(`
        id, work_date, job_name, total_pay, source, sf_status,
        job_work_items ( id, job_type_id, quantity, calculated_pay, custom_description )
      `)
      .eq('tech_id', user.id)
      .eq('week_start_date', selectedWeek)
      .order('work_date', { ascending: true }),
    supabase
      .from('job_types')
      .select('id, name, base_rate, additional_rate, requires_quantity')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('week_submissions')
      .select('submitted_at, admin_unlocked')
      .eq('tech_id', user.id)
      .eq('week_start_date', selectedWeek)
      .maybeSingle(),
  ])

  const deadlinePassed = isDeadlinePassed(selectedWeek)
  const isLocked = (deadlinePassed && !submission?.admin_unlocked) || !!submission?.submitted_at

  return (
    <BulkUpdateClient
      selectedWeek={selectedWeek}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jobs={(jobs ?? []) as any[]}
      jobTypes={jobTypes ?? []}
      isLocked={isLocked}
    />
  )
}
