import { createClient } from '@/lib/supabase/server'
import { getWeekStart, recentWeeks } from '@/lib/week'
import AdminSummaryClient from './AdminSummaryClient'

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  // Default to the most recently completed week (previous week)
  const currentWeek = getWeekStart()
  const allWeeks = recentWeeks(12)
  // Most recently completed = the week before the current one
  const previousWeek = allWeeks[1] ?? currentWeek
  const selectedWeek = params.week ?? previousWeek

  // Load all active technicians
  const { data: techs } = await supabase
    .from('profiles')
    .select('id, full_name, is_active')
    .eq('role', 'technician')
    .order('full_name')

  // Load all jobs for this week (all techs)
  const { data: jobs } = await supabase
    .from('jobs')
    .select(`
      id, tech_id, work_date, job_name, notes, total_pay,
      job_work_items (
        id, quantity, calculated_pay, custom_description,
        job_types ( name, base_rate, additional_rate, requires_quantity )
      )
    `)
    .eq('week_start_date', selectedWeek)
    .order('work_date', { ascending: true })

  // Load all submissions for this week
  const { data: submissions } = await supabase
    .from('week_submissions')
    .select('tech_id, submitted_at')
    .eq('week_start_date', selectedWeek)

  return (
    <AdminSummaryClient
      selectedWeek={selectedWeek}
      currentWeek={currentWeek}
      weeks={allWeeks}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      techs={(techs ?? []) as any[]}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jobs={(jobs ?? []) as any[]}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      submissions={(submissions ?? []) as any[]}
    />
  )
}
