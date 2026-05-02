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
      <div className="max-w-5xl mx-auto px-4 flex items-center justify-between h-14">
        <div className="flex items-center gap-6">
          <Link href={isAdmin ? '/admin' : '/tech'} className="flex items-center shrink-0">
            <Image
              src="/logo.png"
              alt="Castle Garage Doors & Gates"
              height={36}
              width={140}
              className="object-contain"
              priority
            />
          </Link>
          <div className="flex items-center gap-5">
            {isAdmin ? (
              <>
                <NavLink href="/admin" current={pathname === '/admin'}>Summary</NavLink>
                <NavLink href="/admin/rates" current={pathname.startsWith('/admin/rates')}>Pay Rates</NavLink>
                <NavLink href="/admin/techs" current={pathname.startsWith('/admin/techs')}>Technicians</NavLink>
              </>
            ) : (
              <>
                <NavLink href="/tech" current={pathname === '/tech' || (pathname.startsWith('/tech/jobs'))}>My Week</NavLink>
                <NavLink href="/tech/history" current={pathname.startsWith('/tech/history')}>History</NavLink>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-400 hidden sm:inline">{fullName}</span>
          <button
            onClick={handleSignOut}
            className="text-gray-400 hover:text-white transition-colors"
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
        current ? 'text-white underline underline-offset-4' : 'text-gray-400 hover:text-white'
      }`}
    >
      {children}
    </Link>
  )
}
