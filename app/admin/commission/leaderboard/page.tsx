import CommissionNav from '../CommissionNav'
import CommissionLeaderboard from '@/components/CommissionLeaderboard'

export default function CommissionLeaderboardPage() {
  const todayStr = new Date().toISOString().slice(0, 10)
  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Commission</h1>
      <p className="text-sm text-gray-500 mb-4">
        Sales leaderboard — dollars sold and received per technician. Visible to all techs.
      </p>
      <CommissionNav />
      <CommissionLeaderboard todayStr={todayStr} />
    </div>
  )
}
