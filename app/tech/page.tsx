import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getWeekStart } from '@/lib/week'
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

  const [{ data: profile }, { data: jobs }, { data: submission }] = await Promise.all([
    supabase
      .from('profiles')
      .select('sf_technician_id')
      .eq('id', user.id)
      .single(),
    supabase
      .from('jobs')
      .select(`
        id, work_date, job_name, notes, total_pay, week_start_date,
        source, sf_status,
        job_work_items (
          id, quantity, calculated_pay, custom_description,
          job_types ( id, name, base_rate, additional_rate, requires_quantity )
        )
      `)
      .eq('tech_id', user.id)
      .eq('week_start_date', selectedWeek)
      .order('work_date', { ascending: true }),
    supabase
      .from('week_submissions')
      .select('submitted_at, admin_unlocked')
      .eq('tech_id', user.id)
      .eq('week_start_date', selectedWeek)
      .maybeSingle(),
  ])

  return (
    <MyWeekClient
      userId={user.id}
      selectedWeek={selectedWeek}
      currentWeek={currentWeek}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jobs={(jobs ?? []) as any[]}
      submittedAt={submission?.submitted_at ?? null}
      adminUnlocked={submission?.admin_unlocked ?? false}
      sfMapped={!!profile?.sf_technician_id}
    />
  )

}
