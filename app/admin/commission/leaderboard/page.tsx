import CommissionNav from '../CommissionNav'
import LeaderboardClient from '@/components/LeaderboardClient'

export default function CommissionLeaderboardPage() {
  const todayStr = new Date().toISOString().slice(0, 10)
  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Leaderboard</h1>
      <p className="text-sm text-gray-500 mb-4">
        Sales and reviews per technician for the period. Visible to all techs.
      </p>
      <CommissionNav />
      <LeaderboardClient todayStr={todayStr} reviewsHref="/admin/reviews" />
    </div>
  )
}
