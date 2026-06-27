import { createClient } from '@/lib/supabase/server'
import CommissionLeaderboard from '@/components/CommissionLeaderboard'
import TechCommissionTabs from '../TechCommissionTabs'

export default async function TechLeaderboardPage() {
  const todayStr = new Date().toISOString().slice(0, 10)

  // Highlight the logged-in tech's own row.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  let fullName: string | undefined
  if (user) {
    const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single()
    fullName = profile?.full_name ?? undefined
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Commission</h1>
      <p className="text-sm text-gray-500 mb-4">
        Sales leaderboard — see how everyone&rsquo;s tracking this period.
      </p>
      <TechCommissionTabs />
      <CommissionLeaderboard todayStr={todayStr} highlightName={fullName} />
    </div>
  )
}
