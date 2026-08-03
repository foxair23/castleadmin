import CommissionNav from '../CommissionNav'
import { createServiceClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

interface ResetRow {
  id: string
  sf_job_id: string
  job_number: string | null
  customer_name: string | null
  old_work_completed_at: string | null
  current_status: string | null
  job_total: number | null
  had_payment: boolean
  tech_name: string | null
  reset_at: string
}

function fmtDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtMoney(n: number | null): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

export default async function CompletionResetsPage() {
  const db = await createServiceClient()
  const { data } = await db
    .from('commission_completion_resets')
    .select('id, sf_job_id, job_number, customer_name, old_work_completed_at, current_status, job_total, had_payment, tech_name, reset_at')
    .order('reset_at', { ascending: false })
    .limit(500)
  const rows = (data ?? []) as ResetRow[]

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Commission</h1>
      <p className="text-sm text-gray-500 mb-4">
        Jobs whose completion was rolled back in Service Fusion (marked Completed, then reverted to an open
        status). The sync cleared the premature completion date so the job re-recognizes on its real completion
        date, and removed it from commission and the revenue chart until then. A <strong>Payment</strong> flag
        means a payment was already attached — worth a look.
      </p>
      <CommissionNav />
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">
            Completion Resets
            <span className="inline-block ml-2 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">
              {rows.length}
            </span>
          </h2>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-green-600">✓ None — no reverted completions recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Reset', 'Job #', 'Customer', 'Tech', 'Revenue', 'Discarded completion', 'Current status', 'Payment'].map(h => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(r.reset_at)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{r.job_number ?? r.sf_job_id}</td>
                    <td className="px-4 py-2 text-gray-900">{r.customer_name ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{r.tech_name ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-700 whitespace-nowrap">{fmtMoney(r.job_total)}</td>
                    <td className="px-4 py-2 text-gray-600 whitespace-nowrap">{fmtDate(r.old_work_completed_at)}</td>
                    <td className="px-4 py-2 text-gray-600">{r.current_status ?? '—'}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {r.had_payment
                        ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">Had payment</span>
                        : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
