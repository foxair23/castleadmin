import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

function StatCard({ label, value, sub, href }: { label: string; value: number | string; sub?: string; href?: string }) {
  const content = (
    <div className="bg-white rounded-lg border border-gray-200 p-5 hover:border-gray-300 transition-colors">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-3xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
  return href ? <Link href={href}>{content}</Link> : content
}

function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatWindow(start: string, end: string): string {
  function fmt(t: string) {
    const [h] = t.split(':').map(Number)
    return h >= 12 ? `${h === 12 ? 12 : h - 12}pm` : `${h}am`
  }
  return `${fmt(start)}–${fmt(end)}`
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

export default async function SchedulerDashboardPage() {
  const supabase = await createClient()

  const now = new Date()
  const todayStr = now.toISOString().slice(0, 10)

  // 7 days ago
  const sevenDaysAgo = new Date(now)
  sevenDaysAgo.setDate(now.getDate() - 7)
  const sevenDaysAgoStr = sevenDaysAgo.toISOString()

  const [
    { count: totalLeads },
    { count: pendingLeads },
    { count: approvedLeads },
    { count: syncFailed },
    { count: todayLeads },
    { count: weekLeads },
    { data: recentLeads },
    { data: upcomingAppts },
  ] = await Promise.all([
    supabase.from('scheduler_leads').select('id', { count: 'exact', head: true }),
    supabase.from('scheduler_leads').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('scheduler_leads').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    supabase.from('scheduler_leads').select('id', { count: 'exact', head: true }).eq('sync_status', 'sync_failed'),
    supabase.from('scheduler_leads').select('id', { count: 'exact', head: true }).gte('created_at', `${todayStr}T00:00:00`),
    supabase.from('scheduler_leads').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgoStr),
    supabase.from('scheduler_leads')
      .select('id, created_at, status, customer_first_name, customer_last_name, service_category, appointment_date')
      .order('created_at', { ascending: false })
      .limit(5),
    supabase.from('scheduler_leads')
      .select('id, appointment_date, appointment_window_start, appointment_window_end, status, customer_first_name, customer_last_name, service_category, address_city')
      .eq('status', 'approved')
      .gte('appointment_date', todayStr)
      .order('appointment_date', { ascending: true })
      .order('appointment_window_start', { ascending: true })
      .limit(5),
  ])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Scheduler Overview</h1>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total leads" value={totalLeads ?? 0} />
        <StatCard label="Pending" value={pendingLeads ?? 0} sub="Needs review" href="/admin/scheduler/leads" />
        <StatCard label="Today" value={todayLeads ?? 0} />
        <StatCard label="This week" value={weekLeads ?? 0} sub="Last 7 days" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <StatCard label="Approved" value={approvedLeads ?? 0} href="/admin/scheduler/leads" />
        <StatCard
          label="Sync failures"
          value={syncFailed ?? 0}
          sub={syncFailed ? 'Needs attention' : 'All good'}
          href="/admin/scheduler/leads"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent leads */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">Recent leads</h2>
            <Link href="/admin/scheduler/leads" className="text-xs text-red-600 hover:text-red-800">View all</Link>
          </div>
          {(recentLeads ?? []).length === 0 ? (
            <div className="p-5 text-sm text-gray-400 text-center">No leads yet.</div>
          ) : (
            <div className="divide-y divide-gray-50">
              {(recentLeads ?? []).map((lead) => (
                <Link key={lead.id} href={`/admin/scheduler/leads/${lead.id}`} className="block px-5 py-3 hover:bg-gray-50">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {lead.customer_first_name} {lead.customer_last_name}
                      </p>
                      <p className="text-xs text-gray-400">{lead.service_category} · {lead.id}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[lead.status as string] ?? ''}`}>
                        {lead.status as string}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(lead.created_at as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming appointments */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">Upcoming appointments</h2>
          </div>
          {(upcomingAppts ?? []).length === 0 ? (
            <div className="p-5 text-sm text-gray-400 text-center">No upcoming appointments.</div>
          ) : (
            <div className="divide-y divide-gray-50">
              {(upcomingAppts ?? []).map((appt) => (
                <Link key={appt.id} href={`/admin/scheduler/leads/${appt.id}`} className="block px-5 py-3 hover:bg-gray-50">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {appt.customer_first_name} {appt.customer_last_name}
                      </p>
                      <p className="text-xs text-gray-400">
                        {appt.service_category} · {appt.address_city as string}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-gray-700">{formatDate(appt.appointment_date as string)}</p>
                      <p className="text-xs text-gray-400">{formatWindow(appt.appointment_window_start as string, appt.appointment_window_end as string)}</p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
