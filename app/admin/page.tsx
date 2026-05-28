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
    .select('id, full_name, is_active, weekly_bonus')
    .eq('role', 'technician')
    .order('full_name')

  // Load all jobs for this week (all techs)
  const { data: jobs } = await supabase
    .from('jobs')
    .select(`
      id, tech_id, work_date, job_name, notes, total_pay, source, gas_paid, sf_job_id,
      job_work_items (
        id, quantity, calculated_pay, custom_description,
        job_types ( name, base_rate, additional_rate, requires_quantity, requires_sale_amount )
      )
    `)
    .eq('week_start_date', selectedWeek)
    .order('work_date', { ascending: true })

  // Load all submissions for this week
  const { data: submissions } = await supabase
    .from('week_submissions')
    .select('tech_id, submitted_at, admin_unlocked')
    .eq('week_start_date', selectedWeek)

  // Fetch SF invoice line items for SF-sourced jobs
  const sfJobIds = (jobs ?? []).map(j => (j as { sf_job_id?: string | null }).sf_job_id).filter(Boolean) as string[]
  let sfLineItems: Record<string, { name: string | null; quantity: number | null }[]> = {}
  if (sfJobIds.length > 0) {
    const { data: invoices } = await supabase
      .from('sf_invoices')
      .select('id, job_id')
      .in('job_id', sfJobIds)
    if (invoices && invoices.length > 0) {
      const invoiceIds = invoices.map(i => i.id)
      const { data: items } = await supabase
        .from('sf_invoice_line_items')
        .select('invoice_id, name, quantity')
        .in('invoice_id', invoiceIds)
      const invoiceToJobId = new Map(invoices.map(i => [i.id, i.job_id]))
      for (const item of items ?? []) {
        const sfJobId = invoiceToJobId.get(item.invoice_id)
        if (!sfJobId) continue
        if (!sfLineItems[sfJobId]) sfLineItems[sfJobId] = []
        sfLineItems[sfJobId].push({ name: item.name, quantity: item.quantity })
      }
    }
  }

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
      sfLineItems={sfLineItems}
    />
  )
}
