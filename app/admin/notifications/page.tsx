import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import NotificationsClient from './NotificationsClient'

export default async function NotificationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: me } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (!me || me.role !== 'admin' || !me.is_active) redirect('/')

  const adminDb = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const [{ data: types }, { data: profiles }, { data: prefs }] = await Promise.all([
    adminDb
      .from('notification_types')
      .select('id, key, display_name, description, category')
      .eq('is_active', true)
      .order('category')
      .order('display_name'),
    adminDb
      .from('profiles')
      .select('id, full_name, role, is_dispatch')
      .eq('is_active', true)
      .order('full_name'),
    adminDb
      .from('user_notification_preferences')
      .select('user_id, notification_type_id, is_enabled'),
  ])

  // Build a nested map: userId → typeId → isEnabled
  const prefMap = new Map<string, Map<string, boolean>>()
  for (const p of (prefs ?? [])) {
    const uid = p.user_id as string
    const tid = p.notification_type_id as string
    if (!prefMap.has(uid)) prefMap.set(uid, new Map())
    prefMap.get(uid)!.set(tid, p.is_enabled as boolean)
  }

  const users = (profiles ?? []).map(p => ({
    id: p.id as string,
    full_name: p.full_name as string,
    role: p.role as string,
    is_dispatch: (p.is_dispatch as boolean) ?? false,
    prefs: Object.fromEntries(prefMap.get(p.id as string) ?? []),
  }))

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <NotificationsClient types={types ?? []} users={users} />
    </div>
  )
}
