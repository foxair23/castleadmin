import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getWeekStart, getWeekEnd, weekLabel, isDeadlinePassed, formatMoney, parseDate } from '@/lib/week'

export default async function HistoryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const currentWeek = getWeekStart()

  // Get all past weeks where the tech has jobs
  const { data: jobRows } = await supabase
    .from('jobs')
    .select('week_start_date, total_pay')
    .eq('tech_id', user.id)
    .lt('week_start_date', currentWeek)
    .order('week_start_date', { ascending: false })

  // Get all submissions for those weeks
  const { data: submissions } = await supabase
    .from('week_submissions')
    .select('week_start_date, submitted_at')
    .eq('tech_id', user.id)
    .lt('week_start_date', currentWeek)

  const submissionMap = new Map(submissions?.map(s => [s.week_start_date, s.submitted_at]) ?? [])

  // Group jobs by week
  const weekMap = new Map<string, { totalPay: number; jobCount: number }>()
  for (const job of jobRows ?? []) {
    const existing = weekMap.get(job.week_start_date)
    if (existing) {
      existing.totalPay += job.total_pay
      existing.jobCount += 1
    } else {
      weekMap.set(job.week_start_date, { totalPay: job.total_pay, jobCount: 1 })
    }
  }

  const weeks = Array.from(weekMap.entries()).sort((a, b) => b[0].localeCompare(a[0]))

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900">History</h1>
        <p className="text-sm text-gray-500">Past weeks where you logged work</p>
      </div>

      {weeks.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          No past weeks yet.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {weeks.map(([weekStart, { totalPay, jobCount }]) => {
            const submittedAt = submissionMap.get(weekStart)
            const deadlinePassed = isDeadlinePassed(weekStart)

            let statusLabel = ''
            let statusColor = ''
            if (submittedAt) {
              statusLabel = 'Submitted'
              statusColor = 'text-green-700 bg-green-50'
            } else if (deadlinePassed) {
              statusLabel = 'Late / Not submitted'
              statusColor = 'text-red-700 bg-red-50'
            } else {
              statusLabel = 'Not submitted'
              statusColor = 'text-yellow-700 bg-yellow-50'
            }

            return (
              <Link
                key={weekStart}
                href={`/tech?week=${weekStart}`}
                className="flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition-colors"
              >
                <div>
                  <p className="font-medium text-gray-900 text-sm">{weekLabel(weekStart)}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{jobCount} {jobCount === 1 ? 'job' : 'jobs'}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor}`}>
                    {statusLabel}
                  </span>
                  <span className="font-semibold text-gray-900 text-sm">{formatMoney(totalPay)}</span>
                  <span className="text-gray-400 text-xs">›</span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
