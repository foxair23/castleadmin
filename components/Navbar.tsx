'use client'

import Link from 'next/link'
import Image from 'next/image'
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
    <nav className="bg-gray-950 text-white border-b border-gray-800">
      <div className="max-w-5xl mx-auto px-4">
        {/* Mobile: two rows. Desktop (sm+): single row */}
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-6 gap-y-0 h-auto sm:h-14">
          {/* Logo */}
          <Link href={isAdmin ? '/admin' : '/tech'} className="flex items-center shrink-0 py-3 sm:py-0">
            <Image
              src="/logo.png"
              alt="Castle Garage Doors & Gates"
              height={36}
              width={130}
              className="object-contain"
              priority
            />
          </Link>

          {/* Nav links — on mobile: full-width second row; on desktop: inline after logo */}
          <div className="flex items-center gap-6 order-3 sm:order-2 w-full sm:w-auto pb-2 sm:pb-0 overflow-x-auto">
            {isAdmin ? (
              <>
                <NavLink href="/admin" current={pathname === '/admin'}>Summary</NavLink>
                <NavLink href="/admin/rates" current={pathname.startsWith('/admin/rates')}>Pay Rates</NavLink>
                <NavLink href="/admin/techs" current={pathname.startsWith('/admin/techs')}>Technicians</NavLink>
              </>
            ) : (
              <>
                <NavLink href="/tech" current={pathname === '/tech' || pathname.startsWith('/tech/jobs')}>My Week</NavLink>
                <NavLink href="/tech/history" current={pathname.startsWith('/tech/history')}>History</NavLink>
              </>
            )}
          </div>

          {/* Name + sign out — pushed to the right on desktop */}
          <div className="flex items-center gap-4 text-sm ml-auto order-2 sm:order-3 py-3 sm:py-0">
            <span className="text-gray-400 hidden sm:inline truncate max-w-[160px]">{fullName}</span>
            <button
              onClick={handleSignOut}
              className="text-gray-400 hover:text-white transition-colors whitespace-nowrap"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}

function NavLink({ href, current, children }: { href: string; current: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`text-sm font-medium whitespace-nowrap pb-1 border-b-2 transition-colors ${
        current
          ? 'text-white border-red-500'
          : 'text-gray-400 hover:text-white border-transparent'
      }`}
    >
      {children}
    </Link>
  )
}
