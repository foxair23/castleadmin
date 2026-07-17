import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Navbar from '@/components/Navbar'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile || !profile.is_active) {
    await supabase.auth.signOut()
    redirect('/login')
  }
  if (profile.role !== 'admin') redirect('/tech')

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navbar role="admin" fullName={profile.full_name} />
      <main className="flex-1 max-w-screen-2xl w-full mx-auto px-4 py-6">
        {children}
      </main>
    </div>
  )
}
