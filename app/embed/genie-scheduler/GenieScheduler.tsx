'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import ProgressBar from '@/app/embed/scheduler/components/ui/ProgressBar'
import BackButton from '@/app/embed/scheduler/components/ui/BackButton'
import { formatPhoneDisplay, extractDigits, validatePhone, validateEmail } from '@/app/embed/scheduler/lib/validation'
import { fetchAvailability, lookupOrder, submitGenieBooking, GenieMatch, GenieAnswers } from './lib/api'
import { newGenieSessionId, trackGenieStep } from './lib/track'

export interface TimeWindow { start: string; end: string; label: string }
export interface GenieConfig {
  office_phone: string
  time_windows: TimeWindow[]
  available_days: number[]
  scheduling_horizon_days: number
  scheduling_enabled: boolean
  scheduling_disabled_message: string
  min_lead_days: number   // earliest bookable slot is this many days out (motor must ship first)
  slot_mode: 'windows' | 'day'   // 'windows' = pick a date + time window; 'day' = date only
}

type Step = 'identify' | 'notfound' | 'confirm' | 'qualify' | 'schedule' | 'review'
const SECTION_OF: Record<Step, number> = { identify: 1, notfound: 1, confirm: 1, qualify: 2, schedule: 3, review: 4 }
const LABELS = ['Your order', 'Details', 'Schedule', 'Confirm']

// ── date helpers (America/Los_Angeles) ───────────────────────────────────────
function laToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function dow(dateStr: string): number { return new Date(dateStr + 'T12:00:00Z').getUTCDay() }
function prettyDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
function windowLabelOf(start: string, end: string, windows: TimeWindow[]): string {
  return windows.find(w => w.start === start && w.end === end)?.label ?? `${start}–${end}`
}

// ── shared inline styles ──────────────────────────────────────────────────────
const S = {
  card: { background: 'var(--color-white)', borderRadius: 'var(--radius-large)', boxShadow: 'var(--shadow-card)', padding: '1.25rem', margin: '0 auto', maxWidth: 480 } as React.CSSProperties,
  h2: { fontFamily: 'var(--font-heading)', fontSize: '1.25rem', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 0.35rem' } as React.CSSProperties,
  sub: { fontFamily: 'var(--font-body)', fontSize: '0.95rem', color: 'var(--color-text-muted)', margin: '0 0 1rem' } as React.CSSProperties,
  label: { display: 'block', fontFamily: 'var(--font-heading)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text)', margin: '0.75rem 0 0.35rem' } as React.CSSProperties,
  input: { width: '100%', padding: '0.7rem 0.75rem', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-input)', fontSize: '1rem', color: 'var(--color-text)', boxSizing: 'border-box', fontFamily: 'var(--font-body)' } as React.CSSProperties,
  primary: { width: '100%', minHeight: 48, background: 'var(--color-primary)', color: '#fff', border: 0, borderRadius: 'var(--radius-input)', fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', marginTop: '1rem' } as React.CSSProperties,
  primaryDisabled: { opacity: 0.5, cursor: 'not-allowed' } as React.CSSProperties,
  err: { color: 'var(--color-primary)', fontSize: '0.85rem', margin: '0.5rem 0 0', fontFamily: 'var(--font-body)' } as React.CSSProperties,
}
function optionStyle(selected: boolean): React.CSSProperties {
  return {
    display: 'block', width: '100%', textAlign: 'left', padding: '0.8rem 0.9rem', marginTop: '0.5rem',
    border: `1.5px solid ${selected ? 'var(--color-primary)' : 'var(--color-border)'}`,
    background: selected ? '#FEF2F2' : 'var(--color-white)', borderRadius: 'var(--radius-input)',
    fontFamily: 'var(--font-body)', fontSize: '0.95rem', color: 'var(--color-text)', cursor: 'pointer', minHeight: 44,
  }
}

export default function GenieScheduler({ config, widgetKey }: { config: GenieConfig; widgetKey: string }) {
  const [step, setStep] = useState<Step>('identify')
  const [history, setHistory] = useState<Step[]>([])

  // Anonymous funnel tracking — one session id per visit, fired best-effort.
  const [sessionId] = useState(() => newGenieSessionId())
  const track = useMemo(
    () => (s: string, detail?: Record<string, unknown>, orderNumber?: string | null) => trackGenieStep(widgetKey, sessionId, s, detail, orderNumber),
    [widgetKey, sessionId],
  )
  useEffect(() => { track('start') }, [track])

  // identify
  const [method, setMethod] = useState<'phone' | 'email' | 'name'>('phone')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [lastName, setLastName] = useState('')
  const [zip, setZip] = useState('')
  const [looking, setLooking] = useState(false)
  const [error, setError] = useState('')

  // matches / selection
  const [matches, setMatches] = useState<GenieMatch[]>([])
  const [order, setOrder] = useState<GenieMatch | null>(null)

  // qualification answers
  const [answers, setAnswers] = useState<GenieAnswers>({})

  // schedule
  const [selectedDate, setSelectedDate] = useState('')
  const [selectedWindow, setSelectedWindow] = useState<{ start: string; end: string } | null>(null)

  // submit
  const [submitting, setSubmitting] = useState(false)

  function go(next: Step) { setHistory(h => [...h, step]); setError(''); setStep(next) }
  function back() { setHistory(h => { const c = [...h]; const prev = c.pop(); if (prev) setStep(prev); return c }) }

  if (!config.scheduling_enabled) {
    return (
      <div style={{ ...S.card, textAlign: 'center', marginTop: '2rem' }}>
        <p style={S.sub}>{config.scheduling_disabled_message}</p>
        <a href={`tel:${config.office_phone}`} style={{ color: 'var(--color-primary)', fontWeight: 700 }}>{config.office_phone}</a>
      </div>
    )
  }

  async function runLookup() {
    setError('')
    let input: { phone?: string; email?: string; last_name?: string; postal_code?: string }
    if (method === 'phone') {
      if (!validatePhone(phone)) { setError('Enter a 10-digit phone number.'); return }
      input = { phone }
    } else if (method === 'email') {
      if (!validateEmail(email)) { setError('Enter a valid email address.'); return }
      input = { email }
    } else {
      if (lastName.trim().length < 2 || extractDigits(zip).length !== 5) { setError('Enter your last name and 5-digit ZIP code.'); return }
      input = { last_name: lastName, postal_code: zip }
    }
    setLooking(true)
    track('lookup_attempt', { method })
    const res = await lookupOrder(input, widgetKey)
    setLooking(false)
    if (!res.ok) { setError(res.error ?? 'Lookup failed.'); return }
    if (res.matches.length === 0) { track('lookup_not_found', { method }); go('notfound'); return }
    track('lookup_found', { count: res.matches.length })
    setMatches(res.matches)
    if (res.matches.length === 1) { setOrder(res.matches[0]); go('confirm') }
    else go('confirm') // confirm step shows the picker when >1
  }

  return (
    <div style={{ fontFamily: 'var(--font-body)', background: 'var(--color-bg)', minHeight: '100%', padding: '0 0.75rem 2rem' }}>
      <ProgressBar currentSection={SECTION_OF[step]} totalSections={LABELS.length} labels={LABELS} />
      {history.length > 0 && step !== 'review' && (
        <div style={{ maxWidth: 480, margin: '0 auto' }}><BackButton onClick={back} /></div>
      )}

      {step === 'identify' && (
        <div style={S.card}>
          <h2 style={S.h2}>Schedule your Garage Door Opener Installation</h2>
          <p style={S.sub}>Find your order using any of the details you gave Home Depot when you placed your order.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.5rem' }}>
            {([['phone', 'Phone'], ['email', 'Email'], ['name', 'Name + ZIP']] as const).map(([m, label]) => (
              <button key={m} type="button" onClick={() => { setMethod(m); setError('') }}
                style={{ ...optionStyle(method === m), marginTop: 0, textAlign: 'center', flex: '1 0 auto', padding: '0.6rem 0.5rem', fontSize: '0.9rem' }}>{label}</button>
            ))}
          </div>
          {method === 'phone' && (
            <>
              <label style={S.label} htmlFor="g-phone">Phone number</label>
              <input id="g-phone" style={S.input} inputMode="tel" placeholder="(760) 555-1212" value={formatPhoneDisplay(phone)}
                onChange={e => setPhone(extractDigits(e.target.value).slice(0, 10))} onKeyDown={e => e.key === 'Enter' && runLookup()} />
            </>
          )}
          {method === 'email' && (
            <>
              <label style={S.label} htmlFor="g-email">Email address</label>
              <input id="g-email" style={S.input} type="email" placeholder="you@example.com" value={email}
                onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && runLookup()} />
            </>
          )}
          {method === 'name' && (
            <>
              <label style={S.label} htmlFor="g-lname">Last name</label>
              <input id="g-lname" style={S.input} placeholder="Smith" value={lastName}
                onChange={e => setLastName(e.target.value)} onKeyDown={e => e.key === 'Enter' && runLookup()} />
              <label style={S.label} htmlFor="g-zip">ZIP code</label>
              <input id="g-zip" style={S.input} inputMode="numeric" placeholder="92101" value={zip}
                onChange={e => setZip(extractDigits(e.target.value).slice(0, 5))} onKeyDown={e => e.key === 'Enter' && runLookup()} />
            </>
          )}
          {error && <p style={S.err}>{error}</p>}
          <button style={{ ...S.primary, ...(looking ? S.primaryDisabled : {}) }} disabled={looking} onClick={runLookup}>
            {looking ? 'Looking…' : 'Find my order'}
          </button>
        </div>
      )}

      {step === 'notfound' && (
        <div style={{ ...S.card, textAlign: 'center' }}>
          <h2 style={S.h2}>We couldn’t find your order</h2>
          <p style={S.sub}>We couldn’t match that to an order yet. Try another detail above (phone, email, or last name + ZIP), or give our office a call and we’ll get you scheduled.</p>
          <a href={`tel:${config.office_phone}`} style={{ display: 'inline-block', fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '1.15rem', color: 'var(--color-primary)', padding: '0.5rem 0' }}>{config.office_phone}</a>
          <button style={{ ...S.primary, background: 'var(--color-white)', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)' }} onClick={back}>Try again</button>
        </div>
      )}

      {step === 'confirm' && (
        <div style={S.card}>
          <h2 style={S.h2}>{matches.length > 1 ? 'Which order is yours?' : 'Is this you?'}</h2>
          <p style={S.sub}>Please confirm your name, address, and order number below.</p>
          {matches.map(m => {
            const selected = order?.order_id === m.order_id
            return (
              <button key={m.order_id} type="button" onClick={() => setOrder(m)} style={optionStyle(selected)}>
                <div style={{ fontWeight: 700 }}>{m.customer_name ?? `Order ${m.order_number}`}</div>
                {[m.street_address, m.city, m.state_prov].filter(Boolean).length > 0 && (
                  <div style={{ fontSize: '0.9rem', marginTop: 2 }}>{[m.street_address, [m.city, m.state_prov].filter(Boolean).join(', '), m.postal_code].filter(Boolean).join(' · ')}</div>
                )}
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem', marginTop: 3 }}>HD order #{m.order_number}{m.scope ? ` · ${m.scope}` : ''}</div>
                {m.already_scheduled && (
                  <div style={{ color: 'var(--color-primary)', fontSize: '0.8rem', marginTop: 4 }}>Already scheduled for {prettyDate(m.already_scheduled.date)} — choosing again will update it.</div>
                )}
              </button>
            )
          })}
          {error && <p style={S.err}>{error}</p>}
          <button style={{ ...S.primary, ...(order ? {} : S.primaryDisabled) }} disabled={!order} onClick={() => { track('reached_qualification', {}, order?.order_number); go('qualify') }}>Yes, that’s me</button>
        </div>
      )}

      {step === 'qualify' && (
        <Qualify answers={answers} setAnswers={setAnswers} onNext={() => { track('qualification_done', {}, order?.order_number); go('schedule') }} />
      )}

      {step === 'schedule' && (
        <Schedule
          config={config} widgetKey={widgetKey} slotMode={config.slot_mode}
          selectedDate={selectedDate} setSelectedDate={setSelectedDate}
          selectedWindow={selectedWindow} setSelectedWindow={setSelectedWindow}
          track={track} orderNumber={order?.order_number ?? null}
          onNext={() => { track('selected_slot', { date: selectedDate, window: selectedWindow ? `${selectedWindow.start}-${selectedWindow.end}` : 'day' }, order?.order_number); go('review') }}
        />
      )}

      {step === 'review' && order && (selectedWindow || config.slot_mode === 'day') && (
        <div style={S.card}>
          <div style={{ marginBottom: '0.5rem' }}><BackButton onClick={back} /></div>
          <h2 style={S.h2}>Confirm your appointment</h2>
          <ReviewRow label="Order" value={`#${order.order_number}`} />
          <ReviewRow label="Address" value={[order.street_address, order.city, order.state_prov].filter(Boolean).join(', ')} />
          <ReviewRow label="Date" value={prettyDate(selectedDate)} />
          <ReviewRow label="Arrival window" value={selectedWindow ? windowLabelOf(selectedWindow.start, selectedWindow.end, config.time_windows) : 'Any time — our tech will call ahead'} />
          <div style={{ height: 1, background: 'var(--color-border)', margin: '0.75rem 0' }} />
          <ReviewRow label="Door type" value={answers.door_type === 'metal_sectional' ? 'Metal sectional' : answers.door_type === 'one_piece_wood' ? 'One-piece wood' : '—'} />
          <ReviewRow label="Door over 7 ft" value={answers.door_over_7ft ? 'Yes' : 'No'} />
          <ReviewRow label="Cleared 10 ft" value={answers.clearance_10ft ? 'Yes' : 'No'} />
          <ReviewRow label="Adult present" value={answers.adult_present ? 'Yes' : 'No'} />
          <ReviewRow label="Outlet within 3 ft" value={answers.outlet_within_3ft === 'yes' ? 'Yes' : answers.outlet_within_3ft === 'no' ? 'No' : '—'} />
          {error && <p style={S.err}>{error}</p>}
          <button style={{ ...S.primary, ...(submitting ? S.primaryDisabled : {}) }} disabled={submitting} onClick={async () => {
            setSubmitting(true); setError('')
            const res = await submitGenieBooking({
              order_id: order.order_id, appointment_date: selectedDate,
              window_start: selectedWindow?.start, window_end: selectedWindow?.end,
              contact_phone: method === 'phone' ? phone : undefined,
              contact_email: method === 'email' ? email : undefined,
              answers,
            }, widgetKey)
            setSubmitting(false)
            if (!res.ok) { setError(res.error ?? 'Could not schedule.'); return }
            track('booked', { date: selectedDate, sf_synced: res.sf_synced !== false }, res.order_number ?? order.order_number)
            const q = new URLSearchParams({ order: res.order_number ?? order.order_number, date: selectedDate, phone: config.office_phone })
            if (selectedWindow) { q.set('ws', selectedWindow.start); q.set('we', selectedWindow.end) }
            // The SF date-write failed after retries — tell the customer it's a
            // request pending confirmation (the office was alerted to finish it).
            if (res.sf_synced === false) q.set('pending', '1')
            window.location.href = `/embed/genie-scheduler/confirmation?${q.toString()}`
          }}>{submitting ? 'Scheduling…' : 'Confirm appointment'}</button>
        </div>
      )}
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.25rem 0', fontSize: '0.9rem' }}>
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--color-text)', fontWeight: 600, textAlign: 'right' }}>{value || '—'}</span>
    </div>
  )
}

// ── Qualification step ────────────────────────────────────────────────────────
function Qualify({ answers, setAnswers, onNext }: { answers: GenieAnswers; setAnswers: (a: GenieAnswers) => void; onNext: () => void }) {
  const set = (patch: Partial<GenieAnswers>) => setAnswers({ ...answers, ...patch })
  const complete = answers.door_type != null && answers.door_over_7ft != null && answers.clearance_10ft != null && answers.adult_present != null && answers.outlet_within_3ft != null
  const notice: React.CSSProperties = { ...S.sub, background: '#FEF9F0', border: '1px solid #FADFB0', borderRadius: 'var(--radius-input)', padding: '0.6rem 0.7rem', margin: '0.5rem 0 0' }
  return (
    <div style={S.card}>
      <h2 style={S.h2}>A few install details</h2>
      <p style={S.sub}>This helps our tech arrive ready.</p>

      <p style={S.label}>What type of garage door is it?</p>
      <button type="button" style={optionStyle(answers.door_type === 'metal_sectional')} onClick={() => set({ door_type: 'metal_sectional' })}>Metal sectional (panels)</button>
      <button type="button" style={optionStyle(answers.door_type === 'one_piece_wood')} onClick={() => set({ door_type: 'one_piece_wood' })}>One-piece wood</button>

      <p style={S.label}>Is the door taller than 7 feet?</p>
      <button type="button" style={optionStyle(answers.door_over_7ft === false)} onClick={() => set({ door_over_7ft: false })}>7 feet or under</button>
      <button type="button" style={optionStyle(answers.door_over_7ft === true)} onClick={() => set({ door_over_7ft: true })}>Over 7 feet</button>
      {answers.door_over_7ft === true && (
        <p style={notice}>
          Doors over 7 ft require an extension rail, which may involve an additional charge. If the required extension rail is not available at the installation site, it will need to be obtained from Home Depot and the associated cost will apply.
        </p>
      )}

      <p style={S.label}>Is the garage cleared back at least 10 feet from the door?</p>
      <button type="button" style={optionStyle(answers.clearance_10ft === true)} onClick={() => set({ clearance_10ft: true })}>Yes, it’s cleared</button>
      <button type="button" style={optionStyle(answers.clearance_10ft === false)} onClick={() => set({ clearance_10ft: false })}>Not yet</button>
      {answers.clearance_10ft === false && (
        <p style={notice}>
          Please ensure the garage is cleared back at least 10 feet from the garage door to provide sufficient workspace for the installation. If the garage does not have at least 10 feet of clearance, the installation cannot proceed.
        </p>
      )}

      <p style={S.label}>Will an adult (18+) be present during the install?</p>
      <button type="button" style={optionStyle(answers.adult_present === true)} onClick={() => set({ adult_present: true })}>Yes</button>
      <button type="button" style={optionStyle(answers.adult_present === false)} onClick={() => set({ adult_present: false })}>No</button>
      {answers.adult_present === false && (
        <p style={notice}>
          Someone 18 years of age or older must be present at the property during the installation.
        </p>
      )}

      <p style={S.label}>Is there a working electrical outlet within 3 feet of where the opener will be installed?</p>
      <button type="button" style={optionStyle(answers.outlet_within_3ft === 'yes')} onClick={() => set({ outlet_within_3ft: 'yes' })}>Yes</button>
      <button type="button" style={optionStyle(answers.outlet_within_3ft === 'no')} onClick={() => set({ outlet_within_3ft: 'no' })}>No</button>
      {answers.outlet_within_3ft === 'no' && (
        <p style={notice}>
          Please ensure there is a working electrical outlet within 3 feet of where the garage door opener will be installed. Our technicians are not electricians and cannot install outlets. It is the homeowner’s responsibility to hire an electrician before the motor is installed in order to have a working outlet for the garage door opener.
        </p>
      )}

      <label style={S.label} htmlFor="g-notes">Anything else we should know? (optional)</label>
      <textarea id="g-notes" style={{ ...S.input, minHeight: 70, resize: 'vertical' }} value={answers.notes ?? ''} onChange={e => set({ notes: e.target.value })} />

      <button style={{ ...S.primary, ...(complete ? {} : S.primaryDisabled) }} disabled={!complete} onClick={onNext}>Continue to scheduling</button>
    </div>
  )
}

// ── Schedule step ─────────────────────────────────────────────────────────────
function Schedule({ config, widgetKey, slotMode, selectedDate, setSelectedDate, selectedWindow, setSelectedWindow, onNext, track, orderNumber }: {
  config: GenieConfig; widgetKey: string; slotMode: 'windows' | 'day'
  selectedDate: string; setSelectedDate: (d: string) => void
  selectedWindow: { start: string; end: string } | null; setSelectedWindow: (w: { start: string; end: string } | null) => void
  onNext: () => void
  track: (s: string, detail?: Record<string, unknown>, orderNumber?: string | null) => void
  orderNumber: string | null
}) {
  const [avail, setAvail] = useState<Record<string, { available: boolean; windows: Array<{ start: string; end: string; label: string; available: boolean }> }>>({})
  const [loading, setLoading] = useState(true)

  // Earliest bookable day is min_lead_days out — the motor has to ship first —
  // so the first date the customer sees is (today + min_lead_days).
  const leadDays = Math.max(0, config.min_lead_days ?? 0)
  const candidateDates = useMemo(() => {
    const today = laToday()
    const out: string[] = []
    for (let i = leadDays; i <= config.scheduling_horizon_days; i++) {
      const d = addDays(today, i)
      if (config.available_days.includes(dow(d))) out.push(d)
    }
    return out
  }, [leadDays, config.scheduling_horizon_days, config.available_days])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const from = addDays(laToday(), leadDays)
      const to = addDays(laToday(), config.scheduling_horizon_days)
      const data = await fetchAvailability(from, to, widgetKey)
      if (!cancelled) { setAvail(data as typeof avail); setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [leadDays, config.scheduling_horizon_days, widgetKey])

  const bookableDates = candidateDates.filter(d => avail[d]?.available)
  const windowsForDate = selectedDate ? (avail[selectedDate]?.windows ?? []) : []

  // Once availability resolves, record what the customer actually saw: how many
  // dates were bookable and the earliest one offered. This is what separates
  // "no slots at all" from "slots exist but the soonest is too far out (so they
  // called for sooner)". Fired once per visit to this screen.
  const reportedRef = useRef(false)
  useEffect(() => {
    if (loading || reportedRef.current) return
    reportedRef.current = true
    const detail = {
      bookable_count: bookableDates.length,
      earliest_date: bookableDates[0] ?? null,
      lead_days: leadDays,
      horizon: config.scheduling_horizon_days,
    }
    track('reached_scheduling', detail, orderNumber)
    if (bookableDates.length === 0) track('saw_zero_slots', detail, orderNumber)
  }, [loading, bookableDates, leadDays, config.scheduling_horizon_days, track, orderNumber])

  return (
    <div style={S.card}>
      <h2 style={S.h2}>{slotMode === 'day' ? 'Pick a date' : 'Pick a date & time'}</h2>
      <p style={S.sub}>{slotMode === 'day' ? 'Choose the day that works for you — our tech will call ahead before arriving.' : 'Choose an arrival window that works for you. Our tech will call ahead.'}</p>

      {loading ? (
        <p style={S.sub}>Loading available dates…</p>
      ) : bookableDates.length === 0 ? (
        <div style={{ textAlign: 'center' }}>
          <p style={S.sub}>No online dates are open right now. Please call us and we’ll find a time.</p>
          <a href={`tel:${config.office_phone}`} style={{ color: 'var(--color-primary)', fontWeight: 700 }}>{config.office_phone}</a>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', padding: '0.25rem 0 0.5rem' }}>
            {bookableDates.map(d => {
              const selected = selectedDate === d
              return (
                <button key={d} type="button" onClick={() => { setSelectedDate(d); setSelectedWindow(null) }}
                  style={{ flex: '0 0 auto', minWidth: 84, padding: '0.6rem 0.4rem', borderRadius: 'var(--radius-input)', cursor: 'pointer',
                    border: `1.5px solid ${selected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    background: selected ? '#FEF2F2' : 'var(--color-white)', color: 'var(--color-text)', fontFamily: 'var(--font-body)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{prettyDate(d).split(',')[0]}</div>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{prettyDate(d).split(' ').slice(1).join(' ')}</div>
                </button>
              )
            })}
          </div>

          {slotMode === 'windows' && selectedDate && (
            <div style={{ marginTop: '0.75rem' }}>
              {windowsForDate.map(w => {
                const selected = selectedWindow?.start === w.start
                return (
                  <button key={w.start} type="button" disabled={!w.available}
                    onClick={() => setSelectedWindow({ start: w.start, end: w.end })}
                    style={{ ...optionStyle(selected), textAlign: 'center', opacity: w.available ? 1 : 0.4, cursor: w.available ? 'pointer' : 'not-allowed' }}>
                    {w.label}{!w.available ? ' — full' : ''}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      {(() => {
        const ready = !!selectedDate && (slotMode === 'day' || !!selectedWindow)
        return <button style={{ ...S.primary, ...(ready ? {} : S.primaryDisabled) }} disabled={!ready} onClick={onNext}>Review appointment</button>
      })()}
    </div>
  )
}
