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

  // Last week = 7 days before current week
  const lastWeekDate = new Date(currentWeek)
  lastWeekDate.setDate(lastWeekDate.getDate() - 7)
  const lastWeek = lastWeekDate.toISOString().slice(0, 10)

  const [{ data: profile }, { data: jobs }, { data: submission }, { data: lastWeekSubmission }] = await Promise.all([
    supabase
      .from('profiles')
      .select('sf_technician_id, weekly_bonus')
      .eq('id', user.id)
      .single(),
    supabase
      .from('jobs')
      .select(`
        id, work_date, job_name, notes, total_pay, week_start_date,
        source, sf_status, sf_job_number, sf_job_id, gas_paid,
        job_work_items (
          id, quantity, calculated_pay, custom_description,
          job_types ( id, name, base_rate, additional_rate, requires_quantity, requires_sale_amount )
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
    supabase
      .from('week_submissions')
      .select('submitted_at')
      .eq('tech_id', user.id)
      .eq('week_start_date', lastWeek)
      .maybeSingle(),
  ])

  // Fetch SF job items (products/services) for jobs that came from Service Fusion
  const sfJobIds = (jobs ?? []).map(j => (j as { sf_job_id?: string | null }).sf_job_id).filter(Boolean) as string[]
  let sfLineItems: Record<string, { name: string | null; quantity: number | null }[]> = {}
  if (sfJobIds.length > 0) {
    const { data: items } = await supabase
      .from('sf_job_items')
      .select('sf_job_id, name, quantity')
      .in('sf_job_id', sfJobIds)
    for (const item of items ?? []) {
      if (!sfLineItems[item.sf_job_id]) sfLineItems[item.sf_job_id] = []
      sfLineItems[item.sf_job_id].push({ name: item.name, quantity: item.quantity })
    }
  }

  // Show nudge only when viewing current week and last week isn't submitted
  const showLastWeekNudge =
    selectedWeek === currentWeek && !lastWeekSubmission?.submitted_at

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
      weeklyBonus={(profile?.weekly_bonus as number | null) ?? 0}
      lastWeek={lastWeek}
      showLastWeekNudge={showLastWeekNudge}
      sfLineItems={sfLineItems}
    />
  )
}
