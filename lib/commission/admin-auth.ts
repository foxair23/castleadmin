import { createClient } from '@/lib/supabase/server'

/**
 * Returns the authenticated admin user, or null. Shared by commission admin
 * API routes (matches the requireAdmin pattern used elsewhere in the app).
 */
export async function requireCommissionAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()
  if (!profile || profile.role !== 'admin' || !profile.is_active) return null
  return user
}
