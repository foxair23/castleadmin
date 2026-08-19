'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Sub-nav for HD Orders: Genie (the scraped Home Depot / Genie orders) and
// Clopay STS (ship-to-store delivery orders emailed by Clopay). Rendered inside
// both the admin (/admin/vendor-orders) and sales (/sales/hd-orders) areas — the
// base path is passed in so each set of links stays within its own area.
export default function HdOrdersNav({ base }: { base: string }) {
  const pathname = usePathname()
  const tabs = [
    { href: base, label: 'Genie', active: pathname === base },
    { href: `${base}/clopay-sts`, label: 'Clopay STS', active: pathname.startsWith(`${base}/clopay-sts`) },
  ]
  return (
    <div className="flex gap-4 border-b border-gray-200 mb-6 items-end">
      {tabs.map(t => (
        <Link
          key={t.href}
          href={t.href}
          className={`pb-2 text-sm font-medium transition-colors ${
            t.active ? 'text-gray-900 border-b-2 border-red-500' : 'text-gray-500 hover:text-gray-900'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  )
}
