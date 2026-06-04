import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'

export default async function MyNotificationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: me } = await supabase
    .from('profiles')
    .select('role, full_name, is_active')
    .eq('id', user.id)
    .single()

  if (!me || !me.is_active) redirect('/login')
  // Admins manage notifications via /admin/notifications
  if (me.role === 'admin') redirect('/admin/notifications')

  const adminDb = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const [{ data: types }, { data: prefs }] = await Promise.all([
    adminDb
      .from('notification_types')
      .select('id, display_name, description, category')
      .eq('is_active', true)
      .order('category')
      .order('display_name'),
    adminDb
      .from('user_notification_preferences')
      .select('notification_type_id, is_enabled')
      .eq('user_id', user.id),
  ])

  const prefMap = new Map((prefs ?? []).map(p => [p.notification_type_id as string, p.is_enabled as boolean]))

  const categoryLabels: Record<string, string> = {
    payroll: 'Payroll',
    scheduler: 'Scheduler',
    ops: 'Operations',
  }

  // Group types by category
  const byCategory = new Map<string, typeof types>()
  for (const t of (types ?? [])) {
    const cat = t.category as string
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push(t)
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">My Notifications</h1>
        <p className="text-sm text-gray-500 mt-1">
          These are the email notifications currently enabled for your account.
          Contact an admin to change your settings.
        </p>
      </div>

      {[...byCategory.entries()].map(([cat, catTypes]) => (
        <div key={cat} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {categoryLabels[cat] ?? cat}
            </h2>
          </div>
          <ul className="divide-y divide-gray-100">
            {catTypes!.map(t => {
              const enabled = prefMap.get(t.id as string) ?? false
              return (
                <li key={t.id as string} className="flex items-center justify-between px-4 py-3 gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{t.display_name as string}</p>
                    {t.description && (
                      <p className="text-xs text-gray-500 mt-0.5">{t.description as string}</p>
                    )}
                  </div>
                  <span className={`shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    enabled
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}>
                    {enabled ? 'On' : 'Off'}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      <p className="text-xs text-gray-400 text-center">
        All notifications are sent to {user.email}
      </p>
    </div>
  )
}
