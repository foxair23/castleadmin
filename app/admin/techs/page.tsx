import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import TechsClient from './TechsClient'

export default async function TechsPage() {
  const supabase = await createClient()
  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const [{ data: techs }, { data: { users } }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name, role, is_active, created_at, weekly_bonus, gas_eligible, is_dispatch')
      .in('role', ['technician', 'sales'])
      .order('full_name'),
    adminClient.auth.admin.listUsers({ perPage: 1000 }),
  ])

  const emailById = Object.fromEntries(users.map(u => [u.id, u.email ?? '']))

  const techsWithEmail = (techs ?? []).map(t => ({
    ...t,
    email: emailById[t.id] ?? '',
  }))

  return <TechsClient initialTechs={techsWithEmail} />
}
