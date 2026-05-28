import { createClient } from '@/lib/supabase/server'
import LeadsClient from './LeadsClient'

export const dynamic = 'force-dynamic'

export default async function LeadsPage() {
  const supabase = await createClient()

  const { data: leads } = await supabase
    .from('scheduler_leads')
    .select(
      'id, created_at, status, sync_status, is_partial, service_type, service_category, quoted_fee, ' +
      'customer_first_name, customer_last_name, customer_phone, ' +
      'address_city, address_state, address_in_service_area, ' +
      'appointment_date, appointment_window_start, appointment_window_end'
    )
    .order('created_at', { ascending: false })
    .limit(200)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <LeadsClient initialLeads={(leads as any[]) ?? []} />
}
