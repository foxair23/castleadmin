'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/tech/commission', label: 'My Commission', exact: true },
  { href: '/tech/commission/leaderboard', label: 'Leaderboard', exact: false },
]

export default function TechCommissionTabs() {
  const pathname = usePathname()
  return (
    <div className="flex gap-4 border-b border-gray-200 mb-6">
      {TABS.map(t => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href)
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`pb-2 text-sm font-medium transition-colors ${
              active ? 'text-gray-900 border-b-2 border-red-500' : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
