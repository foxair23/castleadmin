import { createClient } from '@/lib/supabase/server'
import SFConnectionClient from './SFConnectionClient'

export default async function SFConnectionPage() {
  const supabase = await createClient()

  const { data: techs } = await supabase
    .from('profiles')
    .select('id, full_name, is_active, sf_technician_id')
    .eq('role', 'technician')
    .order('full_name')

  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <SFConnectionClient initialTechs={(techs ?? []) as any[]} />
  )
}
