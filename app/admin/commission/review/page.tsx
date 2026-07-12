import CommissionNav from '../CommissionNav'
import CommissionReviewTable from './CommissionReviewTable'
import { getCommissionJobsNeedingReview } from '@/lib/analytics/alerts'

export const dynamic = 'force-dynamic'

export default async function CommissionReviewPage() {
  const review = await getCommissionJobsNeedingReview()

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Commission</h1>
      <p className="text-sm text-gray-500 mb-4">
        Jobs the commission engine couldn&rsquo;t auto-credit — multiple agents/tokens, or an
        unmapped agent/token. Credit a technician or mark not accepted; resolving clears the row.
      </p>
      <CommissionNav />
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">
            Needing Review
            <span className={`inline-block ml-2 px-2 py-0.5 rounded-full text-xs font-semibold ${
              review.items.length === 0 ? 'bg-gray-100 text-gray-500' : 'bg-red-100 text-red-700'
            }`}>
              {review.items.length}
            </span>
          </h2>
        </div>
        <div className="px-5 py-3">
          {review.items.length === 0 ? (
            <p className="py-4 text-sm text-green-600">✓ All clear — nothing needs review.</p>
          ) : (
            <CommissionReviewTable items={review.items} techs={review.techs} />
          )}
        </div>
      </div>
    </div>
  )
}
