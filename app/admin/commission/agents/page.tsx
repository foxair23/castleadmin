import CommissionNav from '../CommissionNav'
import AgentsClient from './AgentsClient'

export default function CommissionAgentsPage() {
  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Commission</h1>
      <p className="text-sm text-gray-500 mb-4">
        Map each Service Fusion agent (the rep on a job) to a Castle technician. Jobs credit commission
        based on this mapping.
      </p>
      <CommissionNav />
      <AgentsClient />
    </div>
  )
}
