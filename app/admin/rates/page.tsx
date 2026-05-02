import { createClient } from '@/lib/supabase/server'
import RatesClient from './RatesClient'

export default async function RatesPage() {
  const supabase = await createClient()

  const { data: jobTypes } = await supabase
    .from('job_types')
    .select('id, name, base_rate, additional_rate, requires_quantity, is_active')
    .order('name')

  return <RatesClient initialJobTypes={jobTypes ?? []} />
}
