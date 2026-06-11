'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

interface SalesNavProps {
  role: 'admin' | 'sales'
  fullName: string
}

export default function SalesNav({ role, fullName }: SalesNavProps) {
  const router = useRouter()
  const pathname = usePathname()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <nav className="bg-gray-950 text-white border-b border-gray-800">
      <div className="max-w-6xl mx-auto px-4">
        <div className="flex items-center gap-6 py-3">
          <Link href="/sales" className="flex items-center shrink-0">
            <Image
              src="/logo.png"
              alt="Castle Garage Doors & Gates"
              height={36}
              width={130}
              className="object-contain"
              priority
            />
          </Link>

          <Link
            href="/sales"
            className={`text-sm font-medium pb-0.5 transition-colors ${(pathname === '/sales' || (pathname.startsWith('/sales') && !pathname.startsWith('/sales/action-items'))) ? 'text-white [box-shadow:0_2px_0_0_#ef4444]' : 'text-gray-400 hover:text-white'}`}
          >
            Sales
          </Link>

          <Link
            href="/sales/action-items"
            className={`text-sm font-medium pb-0.5 transition-colors ${pathname.startsWith('/sales/action-items') ? 'text-white [box-shadow:0_2px_0_0_#ef4444]' : 'text-gray-400 hover:text-white'}`}
          >
            Action Items
          </Link>

          {role === 'admin' && (
            <Link
              href="/admin/sales"
              className="text-sm text-gray-400 hover:text-white transition-colors ml-2"
            >
              ← Sales Admin
            </Link>
          )}

          <div className="ml-auto flex items-center gap-4 text-sm">
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
