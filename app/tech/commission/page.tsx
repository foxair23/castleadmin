import TechCommissionClient from './TechCommissionClient'
import TechCommissionTabs from './TechCommissionTabs'

export default function TechCommissionPage() {
  const todayStr = new Date().toISOString().slice(0, 10)
  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">My Commission</h1>
      <p className="text-sm text-gray-500 mb-4">
        Your sales, where each job is in the pipeline, and what you&rsquo;ve earned.
      </p>
      <TechCommissionTabs />
      <TechCommissionClient todayStr={todayStr} />
    </div>
  )
}
