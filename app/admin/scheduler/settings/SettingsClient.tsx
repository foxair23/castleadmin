'use client'

import { useState, useTransition } from 'react'
import { saveSetting } from './actions'

interface TimeWindow {
  start: string
  end: string
  label: string
}

interface Props {
  initialSettings: Record<string, unknown>
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : []
}
function numArr(v: unknown): number[] {
  return Array.isArray(v) ? (v as number[]) : []
}
function timeWindows(v: unknown): TimeWindow[] {
  return Array.isArray(v) ? (v as TimeWindow[]) : []
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 mb-5">
      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">{title}</h2>
      {children}
    </div>
  )
}

function SaveButton({ onClick, disabled, saved }: { onClick: () => void; disabled: boolean; saved: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-4 py-1.5 bg-gray-800 text-white text-sm font-medium rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
    >
      {saved ? 'Saved ✓' : 'Save'}
    </button>
  )
}

function useField<T>(initial: T) {
  const [value, setValue] = useState(initial)
  const [saved, setSaved] = useState(false)
  function markSaved() {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }
  return { value, setValue, saved, markSaved }
}

export default function SettingsClient({ initialSettings: s }: Props) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')

  // General
  const phone = useField(str(s.office_phone))
  const schedulingEnabled = useField(bool(s.scheduling_enabled, true))
  const disabledMsg = useField(str(s.scheduling_disabled_message))
  const horizonDays = useField(String(num(s.scheduling_horizon_days, 14)))
  const availableDays = useField(numArr(s.available_days).length ? numArr(s.available_days) : [1, 2, 3, 4, 5, 6])

  // Capacity
  const minNoticeHours = useField(String(num(s.min_notice_hours, 24)))
  const maxJobsEnabled = useField(num(s.max_jobs_per_day, 0) > 0)
  const maxJobsLimit = useField(String(num(s.max_jobs_per_day, 0) > 0 ? num(s.max_jobs_per_day, 0) : 8))
  const maxWindowEnabled = useField(num(s.max_bookings_per_window, 0) > 0)
  const maxWindowLimit = useField(String(num(s.max_bookings_per_window, 0) > 0 ? num(s.max_bookings_per_window, 0) : 2))

  // Incentive
  const incentiveEnabled = useField(bool(s.incentive_banner_enabled, true))
  const incentiveText = useField(str(s.incentive_banner_text))

  // Pricing
  const serviceCallFee = useField(String(num(s.service_call_fee, 99)))
  const gateServiceCallFee = useField(String(num(s.gate_service_call_fee, 99)))

  // Service Fusion
  const autoSyncToSf = useField(bool(s.auto_sync_to_sf, false))

  // Legal copy
  const tcpaCopy = useField(str(s.tcpa_copy))
  const marketingCopy = useField(str(s.marketing_sms_copy))

  // Categories / issues — stored as JSON arrays, edit as newline-separated text
  const gdCategories = useField(arr(s.garage_door_categories).join('\n'))
  const gateCategories = useField(arr(s.gate_categories).join('\n'))
  const gdIssues = useField(arr(s.garage_door_issues).join('\n'))
  const gateIssues = useField(arr(s.gate_issues).join('\n'))

  // Time windows
  const [windows, setWindows] = useState<TimeWindow[]>(timeWindows(s.time_windows))
  const [windowsSaved, setWindowsSaved] = useState(false)

  function save(key: string, value: unknown, markSaved: () => void) {
    setError('')
    startTransition(async () => {
      try {
        await saveSetting(key, value)
        markSaved()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Save failed')
      }
    })
  }

  function saveLines(key: string, text: string, markSaved: () => void) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    save(key, lines, markSaved)
  }

  function toggleDay(d: number) {
    availableDays.setValue(prev =>
      prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort()
    )
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Scheduler Settings</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      <Section title="General">
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Office phone</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={phone.value}
              onChange={e => phone.setValue(e.target.value)}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            <SaveButton
              onClick={() => save('office_phone', phone.value, phone.markSaved)}
              disabled={isPending}
              saved={phone.saved}
            />
          </div>
        </div>

        <div className="mb-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={schedulingEnabled.value}
              onChange={e => {
                schedulingEnabled.setValue(e.target.checked)
                save('scheduling_enabled', e.target.checked, schedulingEnabled.markSaved)
              }}
              className="rounded border-gray-300 text-red-600 focus:ring-red-500"
            />
            Scheduling enabled
            {schedulingEnabled.saved && <span className="text-green-600 text-xs">Saved ✓</span>}
          </label>
          <p className="text-xs text-gray-400 mt-1 ml-6">When disabled, customers see the message below instead of the booking flow.</p>
        </div>

        {!schedulingEnabled.value && (
          <div className="mb-4 ml-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">Disabled message</label>
            <div className="flex gap-2">
              <textarea
                value={disabledMsg.value}
                onChange={e => disabledMsg.setValue(e.target.value)}
                rows={2}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
              />
              <SaveButton
                onClick={() => save('scheduling_disabled_message', disabledMsg.value, disabledMsg.markSaved)}
                disabled={isPending}
                saved={disabledMsg.saved}
              />
            </div>
          </div>
        )}

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Booking horizon (days)</label>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              min={1}
              max={90}
              value={horizonDays.value}
              onChange={e => horizonDays.setValue(e.target.value)}
              className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            <SaveButton
              onClick={() => save('scheduling_horizon_days', parseInt(horizonDays.value, 10), horizonDays.markSaved)}
              disabled={isPending || !horizonDays.value}
              saved={horizonDays.saved}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">How many days ahead customers can book.</p>
        </div>

        <div className="mb-2">
          <label className="block text-sm font-medium text-gray-700 mb-2">Available days</label>
          <div className="flex gap-2 flex-wrap">
            {[0, 1, 2, 3, 4, 5, 6].map(d => (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  availableDays.value.includes(d)
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'
                }`}
              >
                {DAY_LABELS[d]}
              </button>
            ))}
            <SaveButton
              onClick={() => save('available_days', availableDays.value, availableDays.markSaved)}
              disabled={isPending}
              saved={availableDays.saved}
            />
          </div>
        </div>
      </Section>

      <Section title="Capacity &amp; Lead Time">
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Minimum notice (hours)</label>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              min={0}
              max={168}
              value={minNoticeHours.value}
              onChange={e => minNoticeHours.setValue(e.target.value)}
              className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            <SaveButton
              onClick={() => save('min_notice_hours', parseInt(minNoticeHours.value, 10), minNoticeHours.markSaved)}
              disabled={isPending || minNoticeHours.value === ''}
              saved={minNoticeHours.saved}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">How many hours in advance a customer must book. 0 = no restriction.</p>
        </div>

        <div className="mb-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={maxJobsEnabled.value}
              onChange={e => {
                maxJobsEnabled.setValue(e.target.checked)
                save('max_jobs_per_day', e.target.checked ? parseInt(maxJobsLimit.value, 10) : 0, maxJobsEnabled.markSaved)
              }}
              className="rounded border-gray-300 text-red-600 focus:ring-red-500"
            />
            Limit daily SF jobs
            {maxJobsEnabled.saved && <span className="text-green-600 text-xs">Saved ✓</span>}
          </label>
          {maxJobsEnabled.value && (
            <div className="ml-6">
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  min={1}
                  value={maxJobsLimit.value}
                  onChange={e => maxJobsLimit.setValue(e.target.value)}
                  className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
                />
                <SaveButton
                  onClick={() => save('max_jobs_per_day', parseInt(maxJobsLimit.value, 10), maxJobsLimit.markSaved)}
                  disabled={isPending || !maxJobsLimit.value}
                  saved={maxJobsLimit.saved}
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">Block the whole day in the scheduler when this many SF jobs are already on that date.</p>
            </div>
          )}
          {!maxJobsEnabled.value && (
            <p className="text-xs text-gray-400 ml-6">No daily limit — all dates remain open regardless of SF job count.</p>
          )}
        </div>

        <div className="mb-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={maxWindowEnabled.value}
              onChange={e => {
                maxWindowEnabled.setValue(e.target.checked)
                save('max_bookings_per_window', e.target.checked ? parseInt(maxWindowLimit.value, 10) : 0, maxWindowEnabled.markSaved)
              }}
              className="rounded border-gray-300 text-red-600 focus:ring-red-500"
            />
            Limit online bookings per time window
            {maxWindowEnabled.saved && <span className="text-green-600 text-xs">Saved ✓</span>}
          </label>
          {maxWindowEnabled.value && (
            <div className="ml-6">
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  min={1}
                  value={maxWindowLimit.value}
                  onChange={e => maxWindowLimit.setValue(e.target.value)}
                  className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
                />
                <SaveButton
                  onClick={() => save('max_bookings_per_window', parseInt(maxWindowLimit.value, 10), maxWindowLimit.markSaved)}
                  disabled={isPending || !maxWindowLimit.value}
                  saved={maxWindowLimit.saved}
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">Max pending/approved online leads per AM or PM window per day.</p>
            </div>
          )}
          {!maxWindowEnabled.value && (
            <p className="text-xs text-gray-400 ml-6">No per-window limit — customers can book any available window freely.</p>
          )}
        </div>
      </Section>

      <Section title="Time Windows">
        <div className="space-y-2 mb-3">
          {windows.map((w, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                type="time"
                value={w.start}
                onChange={e => {
                  const next = [...windows]
                  next[i] = { ...w, start: e.target.value }
                  setWindows(next)
                }}
                className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <span className="text-gray-400 text-sm">–</span>
              <input
                type="time"
                value={w.end}
                onChange={e => {
                  const next = [...windows]
                  next[i] = { ...w, end: e.target.value }
                  setWindows(next)
                }}
                className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <input
                type="text"
                value={w.label}
                onChange={e => {
                  const next = [...windows]
                  next[i] = { ...w, label: e.target.value }
                  setWindows(next)
                }}
                placeholder="Label"
                className="flex-1 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <button
                type="button"
                onClick={() => setWindows(windows.filter((_, j) => j !== i))}
                className="text-gray-400 hover:text-red-600 text-sm px-1"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setWindows([...windows, { start: '08:00', end: '12:00', label: '' }])}
            className="text-sm text-gray-500 hover:text-gray-700 underline"
          >
            + Add window
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              save('time_windows', windows, () => {
                setWindowsSaved(true)
                setTimeout(() => setWindowsSaved(false), 2000)
              })
            }}
            className="px-4 py-1.5 bg-gray-800 text-white text-sm font-medium rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            {windowsSaved ? 'Saved ✓' : 'Save windows'}
          </button>
        </div>
      </Section>

      <Section title="Incentive Banner">
        <div className="mb-4">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={incentiveEnabled.value}
              onChange={e => {
                incentiveEnabled.setValue(e.target.checked)
                save('incentive_banner_enabled', e.target.checked, incentiveEnabled.markSaved)
              }}
              className="rounded border-gray-300 text-red-600 focus:ring-red-500"
            />
            Show incentive banner in booking flow
            {incentiveEnabled.saved && <span className="text-green-600 text-xs">Saved ✓</span>}
          </label>
        </div>
        {incentiveEnabled.value && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Banner text</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={incentiveText.value}
                onChange={e => incentiveText.setValue(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <SaveButton
                onClick={() => save('incentive_banner_text', incentiveText.value, incentiveText.markSaved)}
                disabled={isPending}
                saved={incentiveText.saved}
              />
            </div>
          </div>
        )}
      </Section>

      <Section title="Service Categories & Issues">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Garage Door categories</label>
            <textarea
              value={gdCategories.value}
              onChange={e => gdCategories.setValue(e.target.value)}
              rows={6}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
            />
            <SaveButton
              onClick={() => saveLines('garage_door_categories', gdCategories.value, gdCategories.markSaved)}
              disabled={isPending}
              saved={gdCategories.saved}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Gate categories</label>
            <textarea
              value={gateCategories.value}
              onChange={e => gateCategories.setValue(e.target.value)}
              rows={6}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
            />
            <SaveButton
              onClick={() => saveLines('gate_categories', gateCategories.value, gateCategories.markSaved)}
              disabled={isPending}
              saved={gateCategories.saved}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Garage Door issues</label>
            <textarea
              value={gdIssues.value}
              onChange={e => gdIssues.setValue(e.target.value)}
              rows={8}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
            />
            <SaveButton
              onClick={() => saveLines('garage_door_issues', gdIssues.value, gdIssues.markSaved)}
              disabled={isPending}
              saved={gdIssues.saved}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Gate issues</label>
            <textarea
              value={gateIssues.value}
              onChange={e => gateIssues.setValue(e.target.value)}
              rows={8}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
            />
            <SaveButton
              onClick={() => saveLines('gate_issues', gateIssues.value, gateIssues.markSaved)}
              disabled={isPending}
              saved={gateIssues.saved}
            />
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-3">One item per line.</p>
      </Section>

      <Section title="Pricing">
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Garage door service call fee ($)</label>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              min={0}
              step={1}
              value={serviceCallFee.value}
              onChange={e => serviceCallFee.setValue(e.target.value)}
              className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            <SaveButton
              onClick={() => save('service_call_fee', parseInt(serviceCallFee.value, 10), serviceCallFee.markSaved)}
              disabled={isPending || serviceCallFee.value === ''}
              saved={serviceCallFee.saved}
            />
          </div>
        </div>
        <div className="mb-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Gate service call fee ($)</label>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              min={0}
              step={1}
              value={gateServiceCallFee.value}
              onChange={e => gateServiceCallFee.setValue(e.target.value)}
              className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
            <SaveButton
              onClick={() => save('gate_service_call_fee', parseInt(gateServiceCallFee.value, 10), gateServiceCallFee.markSaved)}
              disabled={isPending || gateServiceCallFee.value === ''}
              saved={gateServiceCallFee.saved}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Shown to customers booking garage door or gate repairs and opener service. New door / gate replacements always show &quot;Free Estimate&quot;.
          </p>
        </div>
      </Section>

      <Section title="Service Fusion">
        <div className="mb-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={autoSyncToSf.value}
              onChange={e => {
                autoSyncToSf.setValue(e.target.checked)
                save('auto_sync_to_sf', e.target.checked, autoSyncToSf.markSaved)
              }}
              className="rounded border-gray-300 text-red-600 focus:ring-red-500"
            />
            Auto-send new bookings to Service Fusion
            {autoSyncToSf.saved && <span className="text-green-600 text-xs">Saved ✓</span>}
          </label>
          <p className="text-xs text-gray-400 mt-1 ml-6">
            When enabled, completed bookings are automatically synced to SF without requiring admin approval first.
          </p>
        </div>
      </Section>

      <Section title="Legal Copy">
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">TCPA consent copy</label>
          <textarea
            value={tcpaCopy.value}
            onChange={e => tcpaCopy.setValue(e.target.value)}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none mb-2"
          />
          <SaveButton
            onClick={() => save('tcpa_copy', tcpaCopy.value, tcpaCopy.markSaved)}
            disabled={isPending}
            saved={tcpaCopy.saved}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Marketing SMS consent copy</label>
          <textarea
            value={marketingCopy.value}
            onChange={e => marketingCopy.setValue(e.target.value)}
            rows={2}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none mb-2"
          />
          <SaveButton
            onClick={() => save('marketing_sms_copy', marketingCopy.value, marketingCopy.markSaved)}
            disabled={isPending}
            saved={marketingCopy.saved}
          />
        </div>
      </Section>
    </div>
  )
}
