import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

// "Done" acknowledgement landing page, opened from the email notification.
// This route is behind the auth proxy, so an unauthenticated click is bounced
// to /login?next=... and returns here after sign-in. Admins and sales reps may
// acknowledge; first acknowledgement wins.
export default async function AckLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=/scheduler/ack/${id}`)

  const { data: profile } = await supabase
    .from('profiles').select('role, full_name').eq('id', user.id).single()

  const db = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: lead } = await db
    .from('scheduler_leads')
    .select('id, customer_first_name, customer_last_name, acknowledged_at, acknowledged_by')
    .eq('id', id)
    .maybeSingle()

  const customerName = lead
    ? [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ') || 'this lead'
    : null

  const allowed = ['admin', 'sales'].includes(profile?.role ?? '')
  let acknowledgedNow = false
  let alreadyByName: string | null = null

  if (lead && allowed) {
    if (lead.acknowledged_at) {
      // Already acknowledged — show who did it.
      if (lead.acknowledged_by) {
        const { data: acker } = await db.from('profiles').select('full_name').eq('id', lead.acknowledged_by).maybeSingle()
        alreadyByName = acker?.full_name ?? null
      }
    } else {
      await db.from('scheduler_leads')
        .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: user.id })
        .eq('id', id)
        .is('acknowledged_at', null)
      acknowledgedNow = true
    }
  }

  const homeHref = profile?.role === 'admin' ? '/admin/action-items' : '/sales/action-items'

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
        {!lead ? (
          <>
            <p className="text-lg font-semibold text-white mb-2">Lead not found</p>
            <p className="text-sm text-gray-400">This scheduling lead no longer exists.</p>
          </>
        ) : !allowed ? (
          <>
            <p className="text-lg font-semibold text-white mb-2">Not permitted</p>
            <p className="text-sm text-gray-400">Your account can’t acknowledge scheduling leads.</p>
          </>
        ) : (
          <>
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-600 text-2xl text-white">✓</div>
            <p className="text-lg font-semibold text-white mb-1">
              {acknowledgedNow ? 'Marked done' : 'Already done'}
            </p>
            <p className="text-sm text-gray-400 mb-5">
              {acknowledgedNow
                ? <>You acknowledged <span className="text-gray-200">{customerName}</span>.</>
                : <>This lead was already acknowledged{alreadyByName ? <> by <span className="text-gray-200">{alreadyByName}</span></> : ''}.</>}
            </p>
          </>
        )}
        <Link href={homeHref} className="inline-block bg-red-600 hover:bg-red-700 text-white text-sm font-medium px-4 py-2 rounded-md">
          Go to Action Items
        </Link>
      </div>
    </div>
  )
}
