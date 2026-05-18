import { createClient } from '@/lib/supabase/server'
import ServiceAreaClient from './ServiceAreaClient'

export const dynamic = 'force-dynamic'

export default async function ServiceAreaPage() {
  const supabase = await createClient()

  const { data: cities } = await supabase
    .from('scheduler_service_area_cities')
    .select('id, city, state, is_active')
    .order('city')

  return <ServiceAreaClient initialCities={cities ?? []} />
}
