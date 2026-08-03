import ReviewsReadOnly from '@/components/ReviewsReadOnly'
import { createClient } from '@/lib/supabase/server'
import { getTechCsatSummary } from '@/lib/csat/metrics'

export const metadata = { title: 'Reviews' }

export default async function TechReviewsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let csat: Awaited<ReturnType<typeof getTechCsatSummary>> | null = null
  if (user) {
    const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single()
    csat = await getTechCsatSummary(user.id, (profile?.full_name as string | null) ?? null)
  }

  return (
    <div>
      {csat && csat.responses > 0 && (
        <div className="max-w-4xl mx-auto px-4 pt-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">My CSAT</h2>
          <div className="flex flex-wrap gap-3">
            <div className="flex-1 min-w-[120px] border border-green-200 bg-green-50 rounded-lg px-4 py-3">
              <p className="text-2xl font-bold text-green-700">{csat.csat == null ? '—' : `${csat.csat}%`}</p>
              <p className="text-xs text-green-700 mt-0.5">CSAT (4–5 of valid)</p>
            </div>
            <div className="flex-1 min-w-[120px] border border-blue-200 bg-blue-50 rounded-lg px-4 py-3">
              <p className="text-2xl font-bold text-blue-700">{csat.average == null ? '—' : csat.average.toFixed(1)}</p>
              <p className="text-xs text-blue-700 mt-0.5">Avg rating / 5</p>
            </div>
            <div className="flex-1 min-w-[120px] border border-gray-200 bg-gray-50 rounded-lg px-4 py-3">
              <p className="text-2xl font-bold text-gray-700">{csat.responses}</p>
              <p className="text-xs text-gray-700 mt-0.5">Responses</p>
            </div>
          </div>
        </div>
      )}
      <ReviewsReadOnly />
    </div>
  )
}
