'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

async function assertAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: p } = await supabase.from('profiles').select('role, is_active').eq('id', user.id).single()
  if (!p?.is_active || p.role !== 'admin') redirect('/login')
}

export async function addCity(city: string, state: string) {
  await assertAdmin()
  const supabase = await createClient()
  const { error } = await supabase
    .from('scheduler_service_area_cities')
    .insert({ city: city.trim(), state: state.trim().toUpperCase(), is_active: true })
  if (error) throw new Error(error.message)
  revalidatePath('/admin/scheduler/service-area')
}

export async function toggleCity(id: string, isActive: boolean) {
  await assertAdmin()
  const supabase = await createClient()
  const { error } = await supabase
    .from('scheduler_service_area_cities')
    .update({ is_active: isActive })
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/scheduler/service-area')
}

export async function deleteCity(id: string) {
  await assertAdmin()
  const supabase = await createClient()
  const { error } = await supabase
    .from('scheduler_service_area_cities')
    .delete()
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/admin/scheduler/service-area')
}
