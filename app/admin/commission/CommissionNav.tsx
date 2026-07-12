'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Secondary nav for the admin Commission area. Tabs are added here as later
// phases land (Review queue, Leaderboard).
const TABS: { href: string; label: string; match: (p: string) => boolean }[] = [
  { href: '/admin/commission/techs', label: 'Technicians', match: p => p === '/admin/commission' || p.startsWith('/admin/commission/techs') },
  { href: '/admin/commission/plans', label: 'Plans', match: p => p.startsWith('/admin/commission/plans') },
  { href: '/admin/commission/review', label: 'Review', match: p => p.startsWith('/admin/commission/review') },
  { href: '/admin/commission/acceptances', label: 'Acceptances', match: p => p.startsWith('/admin/commission/acceptances') },
  { href: '/admin/commission/leaderboard', label: 'Leaderboard', match: p => p.startsWith('/admin/commission/leaderboard') },
  { href: '/admin/commission/agents', label: 'Agent Mapping', match: p => p.startsWith('/admin/commission/agents') },
]

export default function CommissionNav() {
  const pathname = usePathname()
  return (
    <div className="flex gap-4 border-b border-gray-200 mb-6">
      {TABS.map(t => {
        const active = t.match(pathname)
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`pb-2 text-sm font-medium transition-colors ${
              active
                ? 'text-gray-900 border-b-2 border-red-500'
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
