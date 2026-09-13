'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const expired = useSearchParams().get('error') === 'expired'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError(error.message)
        setLoading(false)
      } else {
        // Return to the intended destination if one was passed (e.g. an emailed
        // "Done" link). Only honor safe relative paths to avoid open redirects.
        const raw = new URLSearchParams(window.location.search).get('next')
        const next = raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
        router.push(next)
        router.refresh()
      }
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Image
            src="/logo.png"
            alt="Castle Garage Doors & Gates"
            width={280}
            height={100}
            className="object-contain"
            priority
          />
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-base text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-base text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-950 border border-red-800 rounded px-3 py-2">
              {error}
            </p>
          )}
          {expired && !error && (
            <p className="text-sm text-amber-300 bg-amber-950 border border-amber-800 rounded px-3 py-2">
              That reset link has expired or was already used. Request a new one below.
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-medium py-2 px-4 rounded-md text-sm transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <Link href="/login/forgot" className="block text-center text-sm text-gray-400 hover:text-gray-200">Forgot password?</Link>
        </form>
      </div>
    </div>
  )
}

// useSearchParams needs a Suspense boundary for the static shell to prerender.
export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>
}
