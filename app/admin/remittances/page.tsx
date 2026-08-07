import { createClient as createAdminClient } from '@supabase/supabase-js'
import { rematchAllAction, reparseAction, aiReviewAction } from './actions'
import { isAiMatchConfigured } from '@/lib/remittance/ai-match'
import { ActionButton } from './ActionButton'
import { AssignJob, type AssignCandidate } from './AssignJob'
import { ApplyControls } from './ApplyControls'
import { AutopilotToggle } from './AutopilotToggle'
import { SyncFromSfButton } from './SyncFromSfButton'
import { BankReceivedToggle } from './BankReceivedToggle'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Remittances' }

interface EmailRow {
  id: string; vendor_id: string | null; payment_reference: string | null; payment_date: string | null
  payment_amount: number | null; received_at: string; status: string; subject: string | null; raw_text: string | null
  bank_received_at: string | null
}
interface PayRow {
  id: string; email_id: string; line_no: number; po: string | null; customer_name: string | null
  vendor_ref: string | null; amount: number; match_status: string; match_method: string | null; sf_job_number: string | null
  matched_customer: string | null; open_amount: number | null; apply_status: string; error: string | null
  ai_suggested_job_id: string | null; ai_suggested_job_number: string | null; ai_suggested_customer: string | null; ai_confidence: number | null; ai_reason: string | null
  candidates: AssignCandidate[] | null
}
interface VendorRow { id: string; name: string; autopilot: boolean }

// Options for the manual-assign dropdown: the matcher's candidate jobs plus the
// AI-suggested job (if any), deduped by id.
function assignOptions(l: PayRow): AssignCandidate[] {
  const opts = [...(l.candidates ?? [])]
  if (l.ai_suggested_job_id && !opts.some(c => c.id === l.ai_suggested_job_id)) {
    opts.push({ id: l.ai_suggested_job_id, number: l.ai_suggested_job_number, customer_name: l.ai_suggested_customer })
  }
  return opts
}

const money = (n: number | null) => n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const fmtDate = (s: string) => new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
// Date-only in PT — for the received/ingest fallback, so a late-evening ingest
// doesn't visually roll to the next calendar day.
const fmtDateShort = (s: string) => new Date(s).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' })

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
    .select('id, vendor_id, payment_reference, payment_date, payment_amount, received_at, status, subject, raw_text, bank_received_at')
    .order('received_at', { ascending: false }).limit(200)
  const emails = (emailData ?? []) as EmailRow[]
  // Order by the remittance's OWN date (what the vendor put on it) so the list
  // lines up with the emails you received; fall back to ingest time if unparsed.
  const remitTime = (e: EmailRow) => {
    const d = e.payment_date ? Date.parse(e.payment_date) : NaN
    return Number.isNaN(d) ? Date.parse(e.received_at) : d
  }
  emails.sort((a, b) => remitTime(b) - remitTime(a))
  const { data: vendorData } = await db.from('remittance_vendors').select('id, name, autopilot').order('name')
  const vendors = (vendorData ?? []) as VendorRow[]
  const { data: payData } = emails.length
    ? await db.from('remittance_payments')
        .select('id, email_id, line_no, po, customer_name, vendor_ref, amount, match_status, match_method, sf_job_number, matched_customer, open_amount, apply_status, error, ai_suggested_job_id, ai_suggested_job_number, ai_suggested_customer, ai_confidence, ai_reason, candidates')
        .in('email_id', emails.map(e => e.id)).order('line_no')
    : { data: [] }
  const linesByEmail = new Map<string, PayRow[]>()
  for (const p of (payData ?? []) as PayRow[]) {
    const arr = linesByEmail.get(p.email_id) ?? []
    arr.push(p); linesByEmail.set(p.email_id, arr)
  }

  // Per-job overpayment heads-up: sum the matched, not-excluded lines going to
  // each job (across emails) and flag when the total exceeds the job's open
  // balance. The extension enforces this hard against the live invoice balance;
  // this just surfaces it before you run.
  const jobTotals = new Map<string, { sum: number; open: number | null }>()
  for (const p of (payData ?? []) as PayRow[]) {
    if (p.match_status !== 'matched' || !p.sf_job_number || p.apply_status === 'excluded') continue
    const t = jobTotals.get(p.sf_job_number) ?? { sum: 0, open: p.open_amount }
    t.sum += p.amount
    jobTotals.set(p.sf_job_number, t)
  }
  const jobOverpaid = (jobNumber: string | null): { over: boolean; sum: number; open: number | null } => {
    const t = jobNumber ? jobTotals.get(jobNumber) : undefined
    return { over: !!(t && t.open != null && t.sum > t.open + 0.01), sum: t?.sum ?? 0, open: t?.open ?? null }
  }

  // "Completed" = every line has been processed into SF (applied) or excluded.
  // Those roll up to the bottom, collapsed; unfinished ones stay up top.
  const isComplete = (lines: PayRow[]) => lines.length > 0 && lines.every(l => l.apply_status === 'applied' || l.apply_status === 'excluded')
  const inProcess = emails.filter(e => !isComplete(linesByEmail.get(e.id) ?? []))
  const completed = emails.filter(e => isComplete(linesByEmail.get(e.id) ?? []))

  const card = (e: EmailRow, collapsed: boolean) => {
    const lines = linesByEmail.get(e.id) ?? []
    const matched = lines.filter(l => l.match_status === 'matched').length
    const applied = lines.filter(l => l.apply_status === 'applied').length
    return (
      <div key={e.id} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="font-semibold text-gray-900">{e.vendor_id === 'clopay' ? 'Clopay' : e.vendor_id === 'overhead_door' ? 'Overhead Door' : 'Unknown'}</span>
            <span className="ml-2 text-sm text-gray-500">Ref <span className="font-mono">{e.payment_reference ?? '—'}</span></span>
            <span className="ml-2 text-sm text-gray-500" title={`received ${fmtDate(e.received_at)} PT`}>{e.payment_date && e.payment_date.length <= 24 ? e.payment_date : `received ${fmtDateShort(e.received_at)}`}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-gray-700 font-medium">{money(e.payment_amount)}</span>
            <span className="text-gray-500">{matched}/{lines.length} matched · {applied}/{lines.length} posted</span>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${e.status === 'applied' ? 'bg-green-100 text-green-800' : e.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{e.status}</span>
            <BankReceivedToggle emailId={e.id} received={!!e.bank_received_at} />
          </div>
        </div>
        <details open={!collapsed}>
          <summary className="px-4 py-1.5 text-xs text-gray-500 cursor-pointer select-none hover:bg-gray-50 border-b border-gray-100">
            {lines.length} line item{lines.length === 1 ? '' : 's'}{collapsed ? ' — show' : ''}
          </summary>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>{['#', 'PO', 'Customer (remit)', 'Vendor ref', 'Amount', 'Match', 'How', 'Matched job', 'Open', 'Apply'].map(h => (
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
                    <td className="px-3 py-1.5 text-gray-600">
                      {l.sf_job_number ? (
                        <span className="whitespace-nowrap">#{l.sf_job_number}{l.matched_customer ? ` · ${l.matched_customer}` : ''}{l.match_method === 'manual' && <span className="ml-1 text-[10px] text-gray-400">(manual)</span>}</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {l.ai_suggested_job_number && (
                            <span title={l.ai_reason ?? undefined} className="text-indigo-700 text-xs">
                              🤖 suggests #{l.ai_suggested_job_number}{l.ai_suggested_customer ? ` · ${l.ai_suggested_customer}` : ''}{l.ai_confidence != null ? ` (${Math.round(l.ai_confidence * 100)}%)` : ''}
                            </span>
                          )}
                          <AssignJob lineId={l.id} candidates={assignOptions(l)} />
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {(() => { const o = jobOverpaid(l.sf_job_number); return (
                        <span className={o.over ? 'text-amber-700' : 'text-gray-500'}>
                          {money(l.open_amount)}
                          {o.over && <span title={`Lines matched to job #${l.sf_job_number} total ${money(o.sum)}, exceeding its ${money(o.open)} open balance — the extension will skip the payment(s) that go over.`} className="ml-1 text-[10px] font-medium">⚠ over balance</span>}
                        </span>
                      ) })()}
                    </td>
                    <td className="px-3 py-1.5">
                      <ApplyControls lineId={l.id} applyStatus={l.apply_status} matched={l.match_status === 'matched' && !!l.sf_job_number} error={l.error} />
                    </td>
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
        </details>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
        <h1 className="text-2xl font-bold text-gray-900">Vendor Remittances</h1>
        <p className="text-sm text-gray-500 mt-1">
          Parsed payment remittances matched to jobs, then posted to Service Fusion by the poster extension.
          <strong> Approve</strong> a line (or turn on a vendor&rsquo;s autopilot) to queue it. Multiple line items can go
          to the same job — each posts against the invoice&rsquo;s remaining balance, and any payment that would exceed
          what&rsquo;s still owed is flagged and skipped. Each email&rsquo;s raw copy is retained.
        </p>
        {vendors.length > 0 && (
          <div className="flex flex-wrap items-center gap-4 mt-3">
            {vendors.map(v => <AutopilotToggle key={v.id} vendorId={v.id} vendorName={v.name} on={v.autopilot} />)}
          </div>
        )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SyncFromSfButton />
          <ActionButton
            action={rematchAllAction}
            label="Re-run matching"
            pendingLabel="Re-running…"
            className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap"
          />
          <ActionButton
            action={reparseAction}
            label="Re-parse"
            pendingLabel="Re-parsing…"
            className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap"
          />
          {isAiMatchConfigured() && (
            <ActionButton
              action={aiReviewAction}
              label="AI review"
              pendingLabel="AI reviewing…"
              className="px-3 py-1.5 text-sm rounded-md border border-indigo-300 text-indigo-700 hover:bg-indigo-50 whitespace-nowrap"
            />
          )}
        </div>
      </div>

      {emails.length === 0 ? (
        <p className="text-sm text-gray-500 py-8">No remittance emails ingested yet.</p>
      ) : (
        <>
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-700">In Process <span className="text-gray-400 font-normal">({inProcess.length})</span></h2>
            {inProcess.length === 0
              ? <p className="text-sm text-gray-500">Nothing in process — every remittance is fully posted. 🎉</p>
              : inProcess.map(e => card(e, false))}
          </section>
          {completed.length > 0 && (
            <section className="space-y-3 pt-4 border-t border-gray-200">
              <h2 className="text-sm font-semibold text-gray-700">Completed <span className="text-gray-400 font-normal">({completed.length})</span></h2>
              {completed.map(e => card(e, true))}
            </section>
          )}
        </>
      )}
    </div>
  )
}
