import CommissionNav from '../CommissionNav'
import PaymentsOverviewClient from './PaymentsOverviewClient'

export default function CommissionPaymentsPage() {
  const todayStr = new Date().toISOString().slice(0, 10)
  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Payments</h1>
      <p className="text-sm text-gray-500 mb-4">
        What each technician is owed (collected commission), what you&rsquo;ve paid, and the remaining
        balance for a period. Log individual payments from a tech&rsquo;s tab under Technicians.
      </p>
      <CommissionNav />
      <PaymentsOverviewClient todayStr={todayStr} />
    </div>
  )
}
