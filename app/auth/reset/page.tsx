'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

const input = 'w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-base text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500'

// Reached from the emailed reset link (via /auth/callback), signed in with the short-lived
// recovery session. Setting the password here is the only thing that session is for.
export default function ResetPasswordPage() {
  const router = useRouter()
  const [ready, setReady] = useState<'checking' | 'ok' | 'none'>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setReady(data.user ? 'ok' : 'none'))
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < 8) { setError('Use at least 8 characters.'); return }
    if (password !== confirm) { setError('The two passwords do not match.'); return }
    setSaving(true)
    const { error } = await createClient().auth.updateUser({ password })
    if (error) { setError(error.message); setSaving(false); return }
    router.push('/')
    router.refresh()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.png" alt="Castle Garage Doors & Gates" width={280} height={100} className="object-contain" priority />
        </div>
        {ready === 'none' ? (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-3">
            <h1 className="text-white font-medium">This link has expired</h1>
            <p className="text-sm text-gray-400">Reset links work once and expire after an hour. Request a new one and open it in the same browser.</p>
            <Link href="/login/forgot" className="block text-sm text-red-400 hover:text-red-300">Request a new link →</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
            <h1 className="text-white font-medium">Set a new password</h1>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1" htmlFor="password">New password</label>
              <input id="password" type="password" required autoComplete="new-password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} className={input} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1" htmlFor="confirm">Confirm password</label>
              <input id="confirm" type="password" required autoComplete="new-password" minLength={8} value={confirm} onChange={e => setConfirm(e.target.value)} className={input} />
            </div>
            {error && <p className="text-sm text-red-400 bg-red-950 border border-red-800 rounded px-3 py-2">{error}</p>}
            <button type="submit" disabled={saving || ready !== 'ok'} className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-medium py-2 px-4 rounded-md text-sm transition-colors">
              {saving ? 'Saving…' : 'Save and sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
