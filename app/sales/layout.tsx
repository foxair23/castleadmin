import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import SalesNav from './SalesNav'

export default async function SalesLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile?.is_active) {
    await supabase.auth.signOut()
    redirect('/login')
  }
  if (!['admin', 'sales'].includes(profile.role ?? '')) redirect('/login')

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <SalesNav role={profile.role as 'admin' | 'sales'} fullName={profile.full_name} />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        {children}
      </main>
    </div>
  )
}
