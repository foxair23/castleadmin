import { createClient } from '@/lib/supabase/server'

// The approval send flow is operated by admins AND sales users (unlike the
// admin-only commission tooling). Returns the user + role, or null if neither.
export async function requireAdminOrSales(): Promise<{ userId: string; role: 'admin' | 'sales' } | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()
  if (!profile || !profile.is_active || !['admin', 'sales'].includes(profile.role ?? '')) return null
  return { userId: user.id, role: profile.role as 'admin' | 'sales' }
}
