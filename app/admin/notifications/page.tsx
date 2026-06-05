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

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

  const [
    { data: types },
    { data: profiles },
    { data: prefs },
    { data: recentLog },
  ] = await Promise.all([
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
    adminDb
      .from('notification_log')
      .select('id, created_at, user_id, notification_type_id, status, subject, related_entity_type, related_entity_id, error_message')
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(100),
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

  const nameById = new Map((profiles ?? []).map(p => [p.id as string, p.full_name as string]))
  const typeNameById = new Map((types ?? []).map(t => [t.id as string, t.display_name as string]))

  const activity = (recentLog ?? []).map(r => ({
    id: r.id as string,
    createdAt: r.created_at as string,
    userName: nameById.get(r.user_id as string) ?? r.user_id as string,
    typeName: typeNameById.get(r.notification_type_id as string) ?? r.notification_type_id as string,
    status: r.status as string,
    subject: r.subject as string,
    relatedEntityType: (r.related_entity_type as string | null) ?? null,
    relatedEntityId: (r.related_entity_id as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
  }))

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <NotificationsClient types={types ?? []} users={users} activity={activity} />
    </div>
  )
}
