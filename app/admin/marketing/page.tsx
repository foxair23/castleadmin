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

  // Fetch lead sources from sf_sources and categories from sf_job_categories (mirror tables)
  const [
    { data: sourcesData },
    { data: categoriesData },
  ] = await Promise.all([
    db.from('sf_sources').select('id, name').eq('is_deleted', false).order('name'),
    db.from('sf_job_categories').select('id, name').eq('is_deleted', false).order('name'),
  ])

  const leadSources = (sourcesData ?? []).map((s: { id: string; name: string }) => ({ id: String(s.id), name: s.name }))
  const jobCategories = (categoriesData ?? []).map((c: { id: string; name: string }) => ({ id: String(c.id), name: c.name }))

  return (
    <MarketingClient leadSources={leadSources} jobCategories={jobCategories} />
  )
}
