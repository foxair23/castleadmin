'use client'

import { useTransition } from 'react'
import { setBankReceivedAction } from './actions'

// Per-remittance bank-deposit status (one bank payment per email).
export function BankReceivedToggle({ emailId, received }: { emailId: string; received: boolean }) {
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      onClick={() => start(async () => { await setBankReceivedAction(emailId, !received) })}
      disabled={pending}
      title={received ? 'Bank deposit received — click to unmark' : 'Mark the bank deposit as received'}
      className={`px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap disabled:opacity-50 ${
        received ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
      }`}
    >
      {pending ? '…' : received ? '🏦 Bank received' : 'Mark bank received'}
    </button>
  )
}
