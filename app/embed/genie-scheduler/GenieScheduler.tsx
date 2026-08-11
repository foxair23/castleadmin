'use client'

import { useEffect, useMemo, useState } from 'react'
import ProgressBar from '@/app/embed/scheduler/components/ui/ProgressBar'
import BackButton from '@/app/embed/scheduler/components/ui/BackButton'
import { formatPhoneDisplay, extractDigits, validatePhone, validateEmail } from '@/app/embed/scheduler/lib/validation'
import { fetchAvailability, lookupOrder, submitGenieBooking, GenieMatch, GenieAnswers } from './lib/api'

export interface TimeWindow { start: string; end: string; label: string }
export interface GenieConfig {
  office_phone: string
  time_windows: TimeWindow[]
  available_days: number[]
  scheduling_horizon_days: number
  scheduling_enabled: boolean
  scheduling_disabled_message: string
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

  // identify
  const [method, setMethod] = useState<'phone' | 'email'>('phone')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
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
    if (method === 'phone' && !validatePhone(phone)) { setError('Enter a 10-digit phone number.'); return }
    if (method === 'email' && !validateEmail(email)) { setError('Enter a valid email address.'); return }
    setLooking(true)
    const res = await lookupOrder(method === 'phone' ? { phone } : { email }, widgetKey)
    setLooking(false)
    if (!res.ok) { setError(res.error ?? 'Lookup failed.'); return }
    if (res.matches.length === 0) { go('notfound'); return }
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
          <h2 style={S.h2}>Schedule your Genie installation</h2>
          <p style={S.sub}>Find your order using the phone number or email you gave Home Depot when you placed it.</p>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button type="button" onClick={() => setMethod('phone')} style={{ ...optionStyle(method === 'phone'), marginTop: 0, textAlign: 'center' }}>Phone</button>
            <button type="button" onClick={() => setMethod('email')} style={{ ...optionStyle(method === 'email'), marginTop: 0, textAlign: 'center' }}>Email</button>
          </div>
          {method === 'phone' ? (
            <>
              <label style={S.label} htmlFor="g-phone">Phone number</label>
              <input id="g-phone" style={S.input} inputMode="tel" placeholder="(760) 555-1212" value={formatPhoneDisplay(phone)}
                onChange={e => setPhone(extractDigits(e.target.value).slice(0, 10))} onKeyDown={e => e.key === 'Enter' && runLookup()} />
            </>
          ) : (
            <>
              <label style={S.label} htmlFor="g-email">Email address</label>
              <input id="g-email" style={S.input} type="email" placeholder="you@example.com" value={email}
                onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && runLookup()} />
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
          <p style={S.sub}>We couldn’t match that {method === 'phone' ? 'phone number' : 'email'} to an order yet. Please give our office a call and we’ll get you scheduled.</p>
          <a href={`tel:${config.office_phone}`} style={{ display: 'inline-block', fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '1.15rem', color: 'var(--color-primary)', padding: '0.5rem 0' }}>{config.office_phone}</a>
          <button style={{ ...S.primary, background: 'var(--color-white)', color: 'var(--color-primary)', border: '1.5px solid var(--color-primary)' }} onClick={back}>Try again</button>
        </div>
      )}

      {step === 'confirm' && (
        <div style={S.card}>
          <h2 style={S.h2}>{matches.length > 1 ? 'Which order is yours?' : 'Is this your order?'}</h2>
          {matches.map(m => {
            const selected = order?.order_id === m.order_id
            return (
              <button key={m.order_id} type="button" onClick={() => setOrder(m)} style={optionStyle(selected)}>
                <div style={{ fontWeight: 700 }}>{[m.street_address, m.city].filter(Boolean).join(', ') || `Order ${m.order_number}`}</div>
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', marginTop: 2 }}>Order #{m.order_number}{m.scope ? ` · ${m.scope}` : ''}</div>
                {m.already_scheduled && (
                  <div style={{ color: 'var(--color-primary)', fontSize: '0.8rem', marginTop: 4 }}>Already scheduled for {prettyDate(m.already_scheduled.date)} — choosing again will update it.</div>
                )}
              </button>
            )
          })}
          {error && <p style={S.err}>{error}</p>}
          <button style={{ ...S.primary, ...(order ? {} : S.primaryDisabled) }} disabled={!order} onClick={() => go('qualify')}>Yes, that’s me</button>
        </div>
      )}

      {step === 'qualify' && (
        <Qualify answers={answers} setAnswers={setAnswers} onNext={() => go('schedule')} />
      )}

      {step === 'schedule' && (
        <Schedule
          config={config} widgetKey={widgetKey}
          selectedDate={selectedDate} setSelectedDate={setSelectedDate}
          selectedWindow={selectedWindow} setSelectedWindow={setSelectedWindow}
          onNext={() => go('review')}
        />
      )}

      {step === 'review' && order && selectedWindow && (
        <div style={S.card}>
          <div style={{ marginBottom: '0.5rem' }}><BackButton onClick={back} /></div>
          <h2 style={S.h2}>Confirm your appointment</h2>
          <ReviewRow label="Order" value={`#${order.order_number}`} />
          <ReviewRow label="Address" value={[order.street_address, order.city, order.state_prov].filter(Boolean).join(', ')} />
          <ReviewRow label="Date" value={prettyDate(selectedDate)} />
          <ReviewRow label="Arrival window" value={windowLabelOf(selectedWindow.start, selectedWindow.end, config.time_windows)} />
          <div style={{ height: 1, background: 'var(--color-border)', margin: '0.75rem 0' }} />
          <ReviewRow label="Door type" value={answers.door_type === 'metal_sectional' ? 'Metal sectional' : answers.door_type === 'one_piece_wood' ? 'One-piece wood' : '—'} />
          <ReviewRow label="Door over 7 ft" value={answers.door_over_7ft ? 'Yes' : 'No'} />
          <ReviewRow label="Cleared 10 ft" value={answers.clearance_10ft ? 'Yes' : 'No'} />
          <ReviewRow label="Adult present" value={answers.adult_present ? 'Yes' : 'No'} />
          <ReviewRow label="Outlet within 3 ft" value={answers.outlet_within_3ft === 'yes' ? 'Yes' : answers.outlet_within_3ft === 'no' ? 'No' : answers.outlet_within_3ft === 'unsure' ? 'Not sure' : '—'} />
          {error && <p style={S.err}>{error}</p>}
          <button style={{ ...S.primary, ...(submitting ? S.primaryDisabled : {}) }} disabled={submitting} onClick={async () => {
            setSubmitting(true); setError('')
            const res = await submitGenieBooking({
              order_id: order.order_id, appointment_date: selectedDate,
              window_start: selectedWindow.start, window_end: selectedWindow.end,
              contact_phone: method === 'phone' ? phone : undefined,
              contact_email: method === 'email' ? email : undefined,
              answers,
            }, widgetKey)
            setSubmitting(false)
            if (!res.ok) { setError(res.error ?? 'Could not schedule.'); return }
            const q = new URLSearchParams({ order: res.order_number ?? order.order_number, date: selectedDate, ws: selectedWindow.start, we: selectedWindow.end, phone: config.office_phone })
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
  return (
    <div style={S.card}>
      <h2 style={S.h2}>A few install details</h2>
      <p style={S.sub}>This helps our tech arrive ready. Answer honestly — if something isn’t ready we’ll still come, we’ll just plan for it.</p>

      <p style={S.label}>What type of garage door is it?</p>
      <button type="button" style={optionStyle(answers.door_type === 'metal_sectional')} onClick={() => set({ door_type: 'metal_sectional' })}>Metal sectional (panels)</button>
      <button type="button" style={optionStyle(answers.door_type === 'one_piece_wood')} onClick={() => set({ door_type: 'one_piece_wood' })}>One-piece wood</button>

      <p style={S.label}>Is the door taller than 7 feet?</p>
      <button type="button" style={optionStyle(answers.door_over_7ft === false)} onClick={() => set({ door_over_7ft: false })}>7 feet or under</button>
      <button type="button" style={optionStyle(answers.door_over_7ft === true)} onClick={() => set({ door_over_7ft: true })}>Over 7 feet</button>
      {answers.door_over_7ft === true && (
        <p style={{ ...S.sub, background: '#FEF9F0', border: '1px solid #FADFB0', borderRadius: 'var(--radius-input)', padding: '0.6rem 0.7rem', margin: '0.5rem 0 0' }}>
          Doors over 7 ft need an extension rail. If one isn’t already on site it’s sourced from Home Depot, and an additional charge may apply.
        </p>
      )}

      <p style={S.label}>Is the garage cleared back at least 10 feet from the door?</p>
      <button type="button" style={optionStyle(answers.clearance_10ft === true)} onClick={() => set({ clearance_10ft: true })}>Yes, it’s cleared</button>
      <button type="button" style={optionStyle(answers.clearance_10ft === false)} onClick={() => set({ clearance_10ft: false })}>Not yet</button>

      <p style={S.label}>Will an adult (18+) be present during the install?</p>
      <button type="button" style={optionStyle(answers.adult_present === true)} onClick={() => set({ adult_present: true })}>Yes</button>
      <button type="button" style={optionStyle(answers.adult_present === false)} onClick={() => set({ adult_present: false })}>No</button>

      <p style={S.label}>Is there a working electrical outlet within 3 feet of where the opener installs?</p>
      <button type="button" style={optionStyle(answers.outlet_within_3ft === 'yes')} onClick={() => set({ outlet_within_3ft: 'yes' })}>Yes</button>
      <button type="button" style={optionStyle(answers.outlet_within_3ft === 'no')} onClick={() => set({ outlet_within_3ft: 'no' })}>No</button>
      <button type="button" style={optionStyle(answers.outlet_within_3ft === 'unsure')} onClick={() => set({ outlet_within_3ft: 'unsure' })}>Not sure</button>

      <label style={S.label} htmlFor="g-notes">Anything else we should know? (optional)</label>
      <textarea id="g-notes" style={{ ...S.input, minHeight: 70, resize: 'vertical' }} value={answers.notes ?? ''} onChange={e => set({ notes: e.target.value })} />

      <button style={{ ...S.primary, ...(complete ? {} : S.primaryDisabled) }} disabled={!complete} onClick={onNext}>Continue to scheduling</button>
    </div>
  )
}

// ── Schedule step ─────────────────────────────────────────────────────────────
function Schedule({ config, widgetKey, selectedDate, setSelectedDate, selectedWindow, setSelectedWindow, onNext }: {
  config: GenieConfig; widgetKey: string
  selectedDate: string; setSelectedDate: (d: string) => void
  selectedWindow: { start: string; end: string } | null; setSelectedWindow: (w: { start: string; end: string } | null) => void
  onNext: () => void
}) {
  const [avail, setAvail] = useState<Record<string, { available: boolean; windows: Array<{ start: string; end: string; label: string; available: boolean }> }>>({})
  const [loading, setLoading] = useState(true)

  const candidateDates = useMemo(() => {
    const today = laToday()
    const out: string[] = []
    for (let i = 0; i <= config.scheduling_horizon_days; i++) {
      const d = addDays(today, i)
      if (config.available_days.includes(dow(d))) out.push(d)
    }
    return out
  }, [config.scheduling_horizon_days, config.available_days])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const from = laToday()
      const to = addDays(from, config.scheduling_horizon_days)
      const data = await fetchAvailability(from, to, widgetKey)
      if (!cancelled) { setAvail(data as typeof avail); setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [config.scheduling_horizon_days, widgetKey])

  const bookableDates = candidateDates.filter(d => avail[d]?.available)
  const windowsForDate = selectedDate ? (avail[selectedDate]?.windows ?? []) : []

  return (
    <div style={S.card}>
      <h2 style={S.h2}>Pick a date &amp; time</h2>
      <p style={S.sub}>Choose an arrival window that works for you. Our tech will call ahead.</p>

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

          {selectedDate && (
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

      <button style={{ ...S.primary, ...(selectedDate && selectedWindow ? {} : S.primaryDisabled) }} disabled={!selectedDate || !selectedWindow} onClick={onNext}>Review appointment</button>
    </div>
  )
}
