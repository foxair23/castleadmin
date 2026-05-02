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

  const { data: job } = await supabase
    .from('jobs')
    .select(`
      id, work_date, job_name, notes, total_pay, week_start_date,
      job_work_items ( id, job_type_id, quantity, calculated_pay, custom_description )
    `)
    .eq('id', id)
    .eq('tech_id', user.id)
    .single()

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

  // Load active job types
  const { data: jobTypes } = await supabase
    .from('job_types')
    .select('id, name, base_rate, additional_rate, requires_quantity')
    .eq('is_active', true)
    .order('name')

  return (
    <JobForm
      mode="edit"
      weekStart={job.week_start_date}
      userId={user.id}
      jobTypes={jobTypes ?? []}
      existingJob={job}
    />
  )
}
