import CommissionNav from './CommissionNav'
import PlansClient from './PlansClient'

export default function CommissionPlansPage() {
  const todayStr = new Date().toISOString().slice(0, 10)
  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Commission</h1>
      <p className="text-sm text-gray-500 mb-4">
        Set each technician&rsquo;s sales target and tiered rates for the period.
      </p>
      <CommissionNav />
      <PlansClient todayStr={todayStr} />
    </div>
  )
}
