'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { requestPasswordResetAction } from './actions'

const input = 'w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-base text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [pending, start] = useTransition()

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.png" alt="Castle Garage Doors & Gates" width={280} height={100} className="object-contain" priority />
        </div>
        {sent ? (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
            <h1 className="text-white font-medium">Check your email</h1>
            <p className="text-sm text-gray-300">If <span className="text-white">{email}</span> has a Castle Admin account, a password reset link is on its way. The link works once and expires in an hour.</p>
            <p className="text-sm text-gray-400">Nothing after a few minutes? Check spam, or ask an admin to reset it for you.</p>
            <Link href="/login" className="block text-sm text-red-400 hover:text-red-300">← Back to sign in</Link>
          </div>
        ) : (
          <form
            onSubmit={e => { e.preventDefault(); start(async () => { await requestPasswordResetAction(email); setSent(true) }) }}
            className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4"
          >
            <h1 className="text-white font-medium">Forgot your password?</h1>
            <p className="text-sm text-gray-400">Enter your work email and we&apos;ll send a link to set a new one.</p>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1" htmlFor="email">Email</label>
              <input id="email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={input} />
            </div>
            <button type="submit" disabled={pending || !email.trim()} className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-medium py-2 px-4 rounded-md text-sm transition-colors">
              {pending ? 'Sending…' : 'Send reset link'}
            </button>
            <Link href="/login" className="block text-center text-sm text-gray-400 hover:text-gray-200">Back to sign in</Link>
          </form>
        )}
      </div>
    </div>
  )
}
