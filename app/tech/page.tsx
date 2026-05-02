import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getWeekStart, recentWeeks } from '@/lib/week'
import MyWeekClient from './MyWeekClient'

export default async function TechPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const currentWeek = getWeekStart()
  const selectedWeek = params.week ?? currentWeek

  // Load jobs for selected week
  const { data: jobs } = await supabase
    .from('jobs')
    .select(`
      id, work_date, job_name, notes, total_pay, week_start_date,
      job_work_items (
        id, quantity, calculated_pay,
        job_types ( id, name, base_rate, additional_rate, requires_quantity )
      )
    `)
    .eq('tech_id', user.id)
    .eq('week_start_date', selectedWeek)
    .order('work_date', { ascending: true })

  // Check submission status
  const { data: submission } = await supabase
    .from('week_submissions')
    .select('submitted_at')
    .eq('tech_id', user.id)
    .eq('week_start_date', selectedWeek)
    .maybeSingle()

  const weeks = recentWeeks(10)

  return (
    <MyWeekClient
      userId={user.id}
      selectedWeek={selectedWeek}
      currentWeek={currentWeek}
      weeks={weeks}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jobs={(jobs ?? []) as any[]}
      submittedAt={submission?.submitted_at ?? null}
    />
  )
}
