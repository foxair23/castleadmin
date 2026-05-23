'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { approveLead, rejectLead, updateLeadNotes, retrySfSync } from '../actions'

interface Lead {
  id: string
  created_at: string
  status: string
  sync_status: string
  is_partial: boolean
  service_type: string | null
  service_category: string | null
  diagnostic_answers: Record<string, unknown>
  customer_first_name: string
  customer_last_name: string | null
  customer_phone: string
  customer_email: string | null
  customer_sms_appointment_consent: boolean
  customer_sms_marketing_consent: boolean
  address_line1: string | null
  address_line2: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  address_is_owner: boolean
  address_in_service_area: boolean | null
  appointment_date: string | null
  appointment_window_start: string | null
  appointment_window_end: string | null
  description: string | null
  incentive_applied: string | null
  service_fusion_customer_id: string | null
  service_fusion_job_id: string | null
  sync_attempts: unknown[]
  synced_at: string | null
  auto_approved: boolean
  approved_by: string | null
  approved_at: string | null
  rejected_reason: string | null
  notes_internal: string
  lead_source: string
}

interface Props {
  lead: Lead
  approverName: string | null
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return `${DAY_NAMES[dt.getDay()]}, ${MONTH_NAMES[dt.getMonth()]} ${dt.getDate()}, ${y}`
}

function formatWindow(start: string, end: string): string {
  function fmt(t: string) {
    const [h, mn] = t.split(':').map(Number)
    const period = h >= 12 ? 'PM' : 'AM'
    const hr = h % 12 === 0 ? 12 : h % 12
    return mn === 0 ? `${hr} ${period}` : `${hr}:${String(mn).padStart(2, '0')} ${period}`
  }
  return `${fmt(start)} – ${fmt(end)}`
}

function formatPhone(phone: string): string {
  if (phone.length === 10) return `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`
  return phone
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

const STATUS_STYLES: Record<string, string> = {
  pending:  'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
}

const SYNC_LABELS: Record<string, string> = {
  not_attempted:   'Not attempted',
  in_progress:     'In progress',
  synced:          'Synced',
  sync_failed:     'Failed',
  manually_synced: 'Manually synced',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | undefined | null | boolean }) {
  if (value === undefined || value === null || value === '') return null
  const display = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)
  return (
    <div className="flex gap-3 text-sm mb-1.5">
      <span className="text-gray-500 w-40 shrink-0">{label}</span>
      <span className="text-gray-900 font-medium">{display}</span>
    </div>
  )
}

export default function LeadDetailClient({ lead, approverName }: Props) {
  const [isPending, startTransition] = useTransition()
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [notes, setNotes] = useState(lead.notes_internal)
  const [notesSaved, setNotesSaved] = useState(false)
  const [actionError, setActionError] = useState('')

  const diag = lead.diagnostic_answers as {
    issues?: string[]
    opener?: string
    door_type?: string
  }

  function handleApprove() {
    if (!confirm('Approve this lead and send to Service Fusion?')) return
    startTransition(async () => {
      try {
        await approveLead(lead.id)
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Failed to approve')
      }
    })
  }

  function handleReject() {
    startTransition(async () => {
      try {
        await rejectLead(lead.id, rejectReason)
        setShowRejectModal(false)
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Failed to reject')
      }
    })
  }

  function handleSaveNotes() {
    startTransition(async () => {
      try {
        await updateLeadNotes(lead.id, notes)
        setNotesSaved(true)
        setTimeout(() => setNotesSaved(false), 2000)
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Failed to save notes')
      }
    })
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/admin/scheduler/leads" className="text-gray-400 hover:text-gray-600 text-sm">
          ← Leads
        </Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-lg font-bold text-gray-900 font-mono">{lead.id}</h1>
        <span className={`ml-auto px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLES[lead.status] ?? ''}`}>
          {lead.is_partial && lead.status === 'approved' ? 'Actioned' : lead.status.charAt(0).toUpperCase() + lead.status.slice(1)}
        </span>
      </div>

      {lead.is_partial && (
        <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded text-sm text-orange-700">
          <span className="font-semibold">Partial lead</span> — customer dropped off before completing the booking form. Approving marks it as handled; Service Fusion sync is skipped (create the SF job manually if needed).
        </div>
      )}

      {actionError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {actionError}
        </div>
      )}

      {/* Action buttons */}
      {lead.status === 'pending' && (
        <div className="flex gap-3 mb-6">
          <button
            onClick={handleApprove}
            disabled={isPending}
            className="px-5 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {isPending ? 'Working…' : lead.is_partial ? 'Actioned' : 'Approve'}
          </button>
          <button
            onClick={() => setShowRejectModal(true)}
            disabled={isPending}
            className="px-5 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            Reject
          </button>
        </div>
      )}

      {lead.status === 'approved' && (
        <div className="flex gap-3 mb-6">
          <button
            onClick={() => setShowRejectModal(true)}
            disabled={isPending}
            className="px-4 py-2 border border-gray-300 text-gray-600 text-sm font-medium rounded-lg hover:border-red-400 hover:text-red-600 disabled:opacity-50 transition-colors"
          >
            Reverse → Reject
          </button>
        </div>
      )}

      {(lead.appointment_date || lead.incentive_applied) && (
        <Section title="Appointment">
          {lead.appointment_date && <Row label="Date" value={formatDate(lead.appointment_date)} />}
          {lead.appointment_window_start && lead.appointment_window_end && (
            <Row label="Time window" value={formatWindow(lead.appointment_window_start, lead.appointment_window_end)} />
          )}
          {lead.incentive_applied && <Row label="Incentive" value={lead.incentive_applied} />}
        </Section>
      )}

      <Section title="Service">
        {lead.service_type && (
          <Row label="Type" value={lead.service_type === 'garage_door' ? 'Garage Door' : 'Gate'} />
        )}
        <Row label="Category" value={lead.service_category} />
        {diag.issues && diag.issues.length > 0 && <Row label="Issues" value={diag.issues.join(', ')} />}
        {diag.opener && <Row label="Opener" value={diag.opener} />}
        {diag.door_type && <Row label="Door type" value={diag.door_type} />}
        {lead.description && <Row label="Description" value={lead.description} />}
      </Section>

      <Section title="Customer">
        <Row label="Name" value={[lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ')} />
        <Row label="Phone" value={formatPhone(lead.customer_phone)} />
        <Row label="Email" value={lead.customer_email} />
        {!lead.is_partial && <Row label="SMS (appt)" value={lead.customer_sms_appointment_consent} />}
        {!lead.is_partial && <Row label="SMS (marketing)" value={lead.customer_sms_marketing_consent} />}
      </Section>

      {(lead.address_line1 || lead.address_city || lead.address_zip) && (
        <Section title="Address">
          <Row label="Street" value={[lead.address_line1, lead.address_line2].filter(Boolean).join(', ')} />
          {lead.address_city && (
            <Row label="City / State / ZIP" value={[lead.address_city, lead.address_state, lead.address_zip].filter(Boolean).join(' ')} />
          )}
          <Row label="Property owner" value={lead.address_is_owner} />
          <Row
            label="Service area"
            value={lead.address_in_service_area === null ? 'Unknown' : lead.address_in_service_area ? 'In area' : 'Outside area'}
          />
        </Section>
      )}

      <Section title="Service Fusion">
        <Row label="Sync status" value={SYNC_LABELS[lead.sync_status] ?? lead.sync_status} />
        {lead.service_fusion_customer_id && <Row label="SF Customer ID" value={lead.service_fusion_customer_id} />}
        {lead.service_fusion_job_id && <Row label="SF Job ID" value={lead.service_fusion_job_id} />}
        {lead.synced_at && <Row label="Synced at" value={formatTs(lead.synced_at)} />}
        {lead.sync_status === 'sync_failed' && (() => {
          const attempts = lead.sync_attempts as { ok: boolean; error?: string; at: string }[]
          const lastError = [...attempts].reverse().find(a => !a.ok)?.error
          return lastError ? (
            <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-mono whitespace-pre-wrap break-all">
              {lastError}
            </div>
          ) : null
        })()}
        {lead.sync_status === 'sync_failed' && lead.status === 'approved' && (
          <button
            onClick={() => {
              setActionError('')
              startTransition(async () => {
                try { await retrySfSync(lead.id) }
                catch (e) { setActionError(e instanceof Error ? e.message : 'Sync failed') }
              })
            }}
            disabled={isPending}
            className="mt-3 px-4 py-1.5 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {isPending ? 'Retrying…' : 'Retry sync'}
          </button>
        )}
      </Section>

      <Section title="Audit">
        <Row label="Created" value={formatTs(lead.created_at)} />
        <Row label="Lead source" value={lead.lead_source} />
        {lead.approved_at && <Row label="Approved at" value={formatTs(lead.approved_at)} />}
        {approverName && <Row label="Approved by" value={approverName} />}
        {lead.auto_approved && <Row label="Auto-approved" value="Yes" />}
        {lead.rejected_reason && <Row label="Reject reason" value={lead.rejected_reason} />}
      </Section>

      <Section title="Internal Notes">
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={3}
          className="w-full text-sm border border-gray-300 rounded-lg p-3 text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
          placeholder="Add internal notes visible only to admins…"
        />
        <button
          onClick={handleSaveNotes}
          disabled={isPending || notes === lead.notes_internal}
          className="mt-2 px-4 py-1.5 bg-gray-800 text-white text-sm font-medium rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
        >
          {notesSaved ? 'Saved ✓' : 'Save notes'}
        </button>
      </Section>

      {/* Reject modal */}
      {showRejectModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Reject lead</h2>
            <p className="text-sm text-gray-500 mb-4">Optionally explain why this lead is being rejected.</p>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              className="w-full text-sm border border-gray-300 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none mb-4"
              placeholder="Reason (optional)…"
              autoFocus
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowRejectModal(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={isPending}
                className="px-5 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {isPending ? 'Rejecting…' : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
