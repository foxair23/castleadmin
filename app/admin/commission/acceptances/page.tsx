import CommissionNav from '../CommissionNav'
import AcceptancesClient from './AcceptancesClient'

export default function CommissionAcceptancesPage() {
  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Commission</h1>
      <p className="text-sm text-gray-500 mb-4">
        Record of which technician accepted which plan terms, and when — for your files in case of a dispute.
      </p>
      <CommissionNav />
      <AcceptancesClient />
    </div>
  )
}
