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
        <div className="flex flex-wrap items-center gap-x-6">

          {/* Logo — always order-1, stays on row 1 */}
          <Link href={isAdmin ? '/admin' : '/tech'} className="flex items-center shrink-0 py-3 order-1">
            <Image
              src="/logo.png"
              alt="Castle Garage Doors & Gates"
              height={36}
              width={130}
              className="object-contain"
              priority
            />
          </Link>

          {/* Nav links — order-3 (row 2) on narrow, order-2 (inline) on wide */}
          <div className="order-3 sm:order-2 flex items-center gap-6 w-full sm:w-auto pb-2 sm:py-3 overflow-x-auto">
            {isAdmin ? (
              <>
                <NavLink href="/admin" current={pathname === '/admin'}>Summary</NavLink>
                <NavLink href="/admin/dashboard" current={pathname.startsWith('/admin/dashboard')}>Dashboard</NavLink>
                <NavLink href="/admin/rates" current={pathname.startsWith('/admin/rates')}>Pay Rates</NavLink>
                <NavLink href="/admin/techs" current={pathname.startsWith('/admin/techs')}>Technicians</NavLink>
                <NavLink href="/admin/scheduler" current={pathname.startsWith('/admin/scheduler')}>Scheduler</NavLink>
                <NavLink href="/admin/sf" current={pathname.startsWith('/admin/sf')}>Integrations</NavLink>
                <NavLink href="/admin/marketing" current={pathname.startsWith('/admin/marketing')}>Marketing</NavLink>
                <NavLink href="/admin/mailchimp" current={pathname.startsWith('/admin/mailchimp')}>Mailchimp</NavLink>
              </>
            ) : (
              <>
                <NavLink href="/tech" current={pathname === '/tech' || pathname.startsWith('/tech/jobs')}>My Week</NavLink>
                <NavLink href="/tech/history" current={pathname.startsWith('/tech/history')}>History</NavLink>
              </>
            )}
          </div>

          {/* Name + sign out — order-2 (row 1 with logo) on narrow, order-3 on wide */}
          <div className="order-2 sm:order-3 ml-auto flex items-center gap-4 text-sm py-3 shrink-0">
            <span className="text-gray-400 truncate max-w-[160px]">{fullName}</span>
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
      className={`text-sm font-medium whitespace-nowrap transition-colors ${
        current
          ? 'text-white [box-shadow:0_2px_0_0_#ef4444]'
          : 'text-gray-400 hover:text-white'
      }`}
    >
      {children}
    </Link>
  )
}
