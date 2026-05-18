'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/admin/scheduler/leads',    label: 'Leads' },
  { href: '/admin/scheduler/settings', label: 'Settings' },
]

export default function SchedulerSubNav() {
  const pathname = usePathname()
  return (
    <nav className="flex gap-1 border-b border-gray-200 mb-6">
      {TABS.map(tab => {
        const active = pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              active
                ? 'border-red-600 text-red-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
