'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

interface NavbarProps {
  role: 'admin' | 'technician' | 'sales'
  fullName: string
}

export default function Navbar({ role, fullName }: NavbarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const isAdmin = role === 'admin'
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const [syncStale, setSyncStale] = useState(false)

  const checkSyncHealth = useCallback(async () => {
    if (!isAdmin) return
    try {
      const res = await fetch('/api/admin/sf-sync/health')
      if (res.ok) {
        const data = await res.json()
        setSyncStale(data.stale)
      }
    } catch { /* non-critical, ignore */ }
  }, [isAdmin])

  useEffect(() => {
    checkSyncHealth()
  }, [checkSyncHealth])

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const isSettingsActive =
    pathname.startsWith('/admin/rates') ||
    pathname.startsWith('/admin/techs') ||
    pathname.startsWith('/admin/integrations') ||
    pathname.startsWith('/admin/sf') ||
    pathname.startsWith('/admin/mailchimp') ||
    pathname.startsWith('/admin/notifications')

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
                <NavLink href="/admin" current={pathname === '/admin'}>Weekly PW</NavLink>
                <NavLink href="/admin/dashboard" current={pathname.startsWith('/admin/dashboard')}>Dashboard</NavLink>
                <NavLink href="/admin/scheduler" current={pathname.startsWith('/admin/scheduler')}>Scheduler</NavLink>
                <NavLink href="/admin/action-items" current={pathname.startsWith('/admin/action-items')}>Action Items</NavLink>
                <NavLink href="/admin/marketing" current={pathname.startsWith('/admin/marketing')}>Marketing</NavLink>
                <NavLink href="/admin/sales" current={pathname.startsWith('/admin/sales')}>Sales Admin</NavLink>
              </>
            ) : (
              <>
                <NavLink href="/tech" current={pathname === '/tech' || pathname.startsWith('/tech/jobs')}>My Week</NavLink>
                <NavLink href="/tech/history" current={pathname.startsWith('/tech/history')}>History</NavLink>
              </>
            )}
          </div>

          {/* Name + settings gear + sign out */}
          <div className="order-2 sm:order-3 ml-auto flex items-center gap-3 text-sm py-3 shrink-0">
            <span className="text-gray-400 truncate max-w-[160px]">{fullName}</span>

            {isAdmin && (
              <div className="relative" ref={settingsRef}>
                <button
                  onClick={() => setSettingsOpen(o => !o)}
                  title={syncStale ? 'Settings — sync is overdue' : 'Settings'}
                  className={`relative transition-colors ${isSettingsActive || settingsOpen ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  {syncStale && (
                    <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-yellow-400 ring-2 ring-gray-950" />
                  )}
                </button>

                {settingsOpen && (
                  <div className="absolute right-0 top-full mt-1 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 py-1">
                    <DropdownLink
                      href="/admin/techs"
                      active={pathname.startsWith('/admin/techs')}
                      onClick={() => setSettingsOpen(false)}
                    >
                      Users
                    </DropdownLink>
                    <DropdownLink
                      href="/admin/integrations"
                      active={
                        pathname.startsWith('/admin/integrations') ||
                        pathname.startsWith('/admin/sf') ||
                        pathname.startsWith('/admin/mailchimp')
                      }
                      onClick={() => setSettingsOpen(false)}
                    >
                      <span className="flex items-center justify-between w-full">
                        Integrations
                        {syncStale && <span className="h-2 w-2 rounded-full bg-yellow-400 shrink-0" />}
                      </span>
                    </DropdownLink>
                    <DropdownLink
                      href="/admin/rates"
                      active={pathname.startsWith('/admin/rates')}
                      onClick={() => setSettingsOpen(false)}
                    >
                      Pay Rates
                    </DropdownLink>
                    <DropdownLink
                      href="/admin/notifications"
                      active={pathname.startsWith('/admin/notifications')}
                      onClick={() => setSettingsOpen(false)}
                    >
                      Notifications
                    </DropdownLink>
                  </div>
                )}
              </div>
            )}

            {!isAdmin && (
              <Link
                href="/notifications"
                title="My Notifications"
                className={`transition-colors ${pathname === '/notifications' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              </Link>
            )}

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

function DropdownLink({ href, active, onClick, children }: { href: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center px-4 py-2 text-sm transition-colors ${
        active ? 'text-white bg-gray-800' : 'text-gray-300 hover:text-white hover:bg-gray-800'
      }`}
    >
      {children}
    </Link>
  )
}
