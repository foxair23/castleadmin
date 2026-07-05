import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import TechsClient from './TechsClient'
import TechnicianMapping from './TechnicianMapping'

export default async function TechsPage() {
  const supabase = await createClient()
  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const [{ data: techs }, { data: { users } }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name, role, is_active, created_at, weekly_bonus, gas_eligible, is_dispatch, sf_technician_id')
      .in('role', ['technician', 'sales'])
      .order('full_name'),
    adminClient.auth.admin.listUsers({ perPage: 1000 }),
  ])

  const emailById = Object.fromEntries(users.map(u => [u.id, u.email ?? '']))

  const techsWithEmail = (techs ?? []).map(t => ({
    ...t,
    email: emailById[t.id] ?? '',
  }))

  // Service Fusion mapping is per-technician (sales users don't map to SF techs).
  const mappingTechs = (techs ?? [])
    .filter(t => t.role === 'technician')
    .map(t => ({
      id: t.id,
      full_name: t.full_name,
      is_active: t.is_active,
      sf_technician_id: t.sf_technician_id ?? null,
    }))

  return (
    <div className="space-y-8">
      <TechsClient initialTechs={techsWithEmail} />
      <TechnicianMapping initialTechs={mappingTechs} />
    </div>
  )
}
