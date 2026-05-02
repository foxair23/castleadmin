import { createClient } from '@/lib/supabase/server'
import TechsClient from './TechsClient'

export default async function TechsPage() {
  const supabase = await createClient()

  const { data: techs } = await supabase
    .from('profiles')
    .select('id, full_name, role, is_active, created_at')
    .eq('role', 'technician')
    .order('full_name')

  return <TechsClient initialTechs={techs ?? []} />
}
