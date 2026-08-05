import { createClient as createAdminClient } from '@supabase/supabase-js'
import { rematchAllAction } from './actions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Remittances' }

interface EmailRow {
  id: string; vendor_id: string | null; payment_reference: string | null; payment_date: string | null
  payment_amount: number | null; received_at: string; status: string; subject: string | null; raw_text: string | null
}
interface PayRow {
  id: string; email_id: string; line_no: number; po: string | null; customer_name: string | null
  vendor_ref: string | null; amount: number; match_status: string; match_method: string | null; sf_job_number: string | null
  matched_customer: string | null; open_amount: number | null; apply_status: string
}

const money = (n: number | null) => n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtDate = (s: string) => new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

const MATCH_STYLE: Record<string, string> = {
  matched: 'bg-green-100 text-green-800',
  ambiguous: 'bg-amber-100 text-amber-800',
  amount_mismatch: 'bg-amber-100 text-amber-800',
  no_match: 'bg-red-100 text-red-700',
}

// How the line matched. Name-only matches are correct but unverified by PO, so
// they're flagged amber to draw a human check before applying.
const METHOD_LABEL: Record<string, { label: string; cls: string }> = {
  po: { label: 'PO', cls: 'bg-gray-100 text-gray-500' },
  po_name: { label: 'PO + name', cls: 'bg-gray-100 text-gray-500' },
  name: { label: 'name only — verify', cls: 'bg-amber-100 text-amber-800' },
}

export default async function RemittancesPage() {
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: emailData } = await db.from('remittance_emails')
    .select('id, vendor_id, payment_reference, payment_date, payment_amount, received_at, status, subject, raw_text')
    .order('received_at', { ascending: false }).limit(200)
  const emails = (emailData ?? []) as EmailRow[]
  const { data: payData } = emails.length
    ? await db.from('remittance_payments')
        .select('id, email_id, line_no, po, customer_name, vendor_ref, amount, match_status, match_method, sf_job_number, matched_customer, open_amount, apply_status')
        .in('email_id', emails.map(e => e.id)).order('line_no')
    : { data: [] }
  const linesByEmail = new Map<string, PayRow[]>()
  for (const p of (payData ?? []) as PayRow[]) {
    const arr = linesByEmail.get(p.email_id) ?? []
    arr.push(p); linesByEmail.set(p.email_id, arr)
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
        <h1 className="text-2xl font-bold text-gray-900">Vendor Remittances</h1>
        <p className="text-sm text-gray-500 mt-1">
          Parsed payment remittances matched to jobs by PO. Applying to Service Fusion is pending a one-time live
          verification of SF&rsquo;s payment-apply behavior — this view is the parse + match + audit log, with each
          email&rsquo;s raw copy retained.
        </p>
        </div>
        <form action={rematchAllAction}>
          <button type="submit" className="shrink-0 px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
            Re-run matching
          </button>
        </form>
      </div>

      {emails.length === 0 ? (
        <p className="text-sm text-gray-500 py-8">No remittance emails ingested yet.</p>
      ) : emails.map(e => {
        const lines = linesByEmail.get(e.id) ?? []
        const matched = lines.filter(l => l.match_status === 'matched').length
        return (
          <div key={e.id} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="font-semibold text-gray-900">{e.vendor_id === 'clopay' ? 'Clopay' : e.vendor_id === 'overhead_door' ? 'Overhead Door' : 'Unknown'}</span>
                <span className="ml-2 text-sm text-gray-500">Ref <span className="font-mono">{e.payment_reference ?? '—'}</span></span>
                <span className="ml-2 text-sm text-gray-500">{fmtDate(e.received_at)}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <span className="text-gray-700 font-medium">{money(e.payment_amount)}</span>
                <span className="text-gray-500">{matched}/{lines.length} matched</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${e.status === 'applied' ? 'bg-green-100 text-green-800' : e.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{e.status}</span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>{['#', 'PO', 'Customer (remit)', 'Vendor ref', 'Amount', 'Match', 'How', 'Matched job', 'Open'].map(h => (
                    <th key={h} className="px-3 py-1.5 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {lines.map(l => (
                    <tr key={l.id} className="hover:bg-gray-50">
                      <td className="px-3 py-1.5 text-gray-400">{l.line_no}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-gray-700">{l.po ?? '—'}</td>
                      <td className="px-3 py-1.5 text-gray-700">{l.customer_name ?? '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-gray-500">{l.vendor_ref ?? '—'}</td>
                      <td className="px-3 py-1.5 text-gray-900 whitespace-nowrap">{money(l.amount)}</td>
                      <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${MATCH_STYLE[l.match_status] ?? 'bg-gray-100 text-gray-600'}`}>{l.match_status}</span></td>
                      <td className="px-3 py-1.5">{l.match_method && METHOD_LABEL[l.match_method] ? <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${METHOD_LABEL[l.match_method].cls}`}>{METHOD_LABEL[l.match_method].label}</span> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{l.sf_job_number ? `#${l.sf_job_number}` : '—'}{l.matched_customer ? ` · ${l.matched_customer}` : ''}</td>
                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{money(l.open_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {e.raw_text && (
              <details className="px-4 py-2 border-t border-gray-100">
                <summary className="text-xs text-gray-500 cursor-pointer">Raw email (retained copy)</summary>
                <pre className="mt-2 text-[11px] text-gray-600 whitespace-pre-wrap max-h-64 overflow-auto">{e.raw_text}</pre>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}
