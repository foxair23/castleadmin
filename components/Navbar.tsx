'use client'

import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

interface NavbarProps {
  role: 'admin' | 'technician'
  fullName: string
}

export default function Navbar({ role, fullName }: NavbarProps) {
  const router = useRouter()
  const pathname = usePathname()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const isAdmin = role === 'admin'

  return (
    <nav className="bg-red-800 text-white">
      <div className="max-w-5xl mx-auto px-4 flex items-center justify-between h-14">
        <div className="flex items-center gap-6">
          <span className="font-bold text-sm tracking-wide">Castle Payroll</span>
          {isAdmin ? (
            <>
              <NavLink href="/admin" current={pathname === '/admin'}>Summary</NavLink>
              <NavLink href="/admin/rates" current={pathname.startsWith('/admin/rates')}>Pay Rates</NavLink>
              <NavLink href="/admin/techs" current={pathname.startsWith('/admin/techs')}>Technicians</NavLink>
            </>
          ) : (
            <NavLink href="/tech" current={pathname.startsWith('/tech')}>My Week</NavLink>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-red-200 hidden sm:inline">{fullName}</span>
          <button
            onClick={handleSignOut}
            className="text-red-200 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  )
}

function NavLink({ href, current, children }: { href: string; current: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`text-sm font-medium transition-colors ${
        current ? 'text-white underline underline-offset-4' : 'text-red-200 hover:text-white'
      }`}
    >
      {children}
    </Link>
  )
}
