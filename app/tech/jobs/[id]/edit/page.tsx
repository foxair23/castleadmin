import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isDeadlinePassed } from '@/lib/week'
import JobForm from '../../JobForm'

export default async function EditJobPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: job }, { data: profile }, { data: jobTypes }] = await Promise.all([
    supabase
      .from('jobs')
      .select(`
        id, work_date, job_name, notes, total_pay, week_start_date, source,
        sf_job_id, sf_job_number, gas_paid,
        job_work_items ( id, job_type_id, quantity, calculated_pay, custom_description )
      `)
      .eq('id', id)
      .eq('tech_id', user.id)
      .single(),
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

  if (!job) redirect('/tech')

  const { data: submission } = await supabase
    .from('week_submissions')
    .select('id, admin_unlocked')
    .eq('tech_id', user.id)
    .eq('week_start_date', job.week_start_date)
    .maybeSingle()

  if (isDeadlinePassed(job.week_start_date) && !submission?.admin_unlocked) {
    redirect(`/tech?week=${job.week_start_date}`)
  }

  return (
    <JobForm
      mode="edit"
      weekStart={job.week_start_date}
      userId={user.id}
      jobTypes={jobTypes ?? []}
      gasEligible={profile?.gas_eligible ?? false}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      existingJob={job as any}
      source={job.source}
      sfJobId={job.sf_job_id ?? undefined}
      sfJobNumber={job.sf_job_number ?? undefined}
    />
  )
}
