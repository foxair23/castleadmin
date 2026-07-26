import CommissionNav from '../CommissionNav'
import UpsellClient from './UpsellClient'

export const metadata = { title: 'Upsell' }

export default function CommissionUpsellPage() {
  const todayStr = new Date().toISOString().slice(0, 10)
  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Upsell</h1>
      <p className="text-sm text-gray-500 mb-4">
        Incremental revenue per tech — each commission job&rsquo;s total the morning of the service
        day (7am PT, before the tech went out) vs. its final commission revenue. Jobs without a
        captured baseline show &ldquo;&mdash;&rdquo; and are excluded from the totals.
      </p>
      <CommissionNav />
      <UpsellClient todayStr={todayStr} />
    </div>
  )
}
