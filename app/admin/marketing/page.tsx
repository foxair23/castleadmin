import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import MarketingClient from './MarketingClient'

export default async function MarketingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/admin')

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Fetch distinct lead sources from customers + jobs
  const [
    { data: customerSources },
    { data: jobSources },
    { data: categoriesData },
  ] = await Promise.all([
    db.from('sf_customers_cache').select('lead_source').not('lead_source', 'is', null),
    db.from('sf_jobs_cache').select('lead_source').not('lead_source', 'is', null),
    db.from('sf_job_categories_ref').select('id, name').order('name'),
  ])

  const sourceSet = new Set<string>()
  for (const row of customerSources ?? []) {
    if (row.lead_source) sourceSet.add(row.lead_source)
  }
  for (const row of jobSources ?? []) {
    if (row.lead_source) sourceSet.add(row.lead_source)
  }
  const leadSources = Array.from(sourceSet).sort().map(name => ({ id: name, name }))
  const jobCategories = (categoriesData ?? []).map((c: { id: string; name: string }) => ({ id: String(c.id), name: c.name }))

  return (
    <MarketingClient leadSources={leadSources} jobCategories={jobCategories} />
  )
}
