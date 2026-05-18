'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlowState, SchedulerConfig, BookingPayload } from '../../lib/types';
import { submitBooking } from '../../lib/api';
import { formatPhoneDisplay } from '../../lib/validation';

interface Props {
  state: FlowState;
  config: SchedulerConfig;
  widgetKey: string;
  onNext: (partial: Partial<FlowState>) => void;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${year}`;
}

function formatWindow(start: string, end: string): string {
  function fmt(t: string): string {
    const [h, m] = t.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? `${hour} ${period}` : `${hour}:${String(m).padStart(2, '0')} ${period}`;
  }
  return `${fmt(start)} – ${fmt(end)}`;
}

function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ backgroundColor: 'var(--color-bg)', borderRadius: 'var(--radius-card)', padding: '1rem 1.25rem', marginBottom: '0.875rem' }}>
      <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.625rem' }}>{title}</p>
      {children}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string | undefined | null }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
      <span style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)', minWidth: '120px', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '0.875rem', color: 'var(--color-text)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

export default function StepReview({ state, config, widgetKey, onNext }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!state.service_type || !state.service_category || !state.opener || !state.door_type || !state.appointment_date || !state.appointment_window_start || !state.appointment_window_end) {
      setError('Something is missing. Please go back and complete all steps.');
      return;
    }

    const payload: BookingPayload = {
      service_type: state.service_type,
      service_category: state.service_category,
      diagnostic_answers: { issues: state.issues, opener: state.opener, door_type: state.door_type },
      customer_first_name: state.customer_first_name,
      customer_last_name: state.customer_last_name,
      customer_phone: state.customer_phone,
      customer_email: state.customer_email,
      customer_sms_appointment_consent: state.customer_sms_appointment_consent,
      customer_sms_marketing_consent: state.customer_sms_marketing_consent,
      address_line1: state.address_line1,
      address_line2: state.address_line2 || undefined,
      address_city: state.address_city,
      address_state: state.address_state,
      address_zip: state.address_zip,
      address_is_owner: state.address_is_owner,
      appointment_date: state.appointment_date,
      appointment_window_start: state.appointment_window_start,
      appointment_window_end: state.appointment_window_end,
      description: state.description || undefined,
    };

    setLoading(true);
    setError('');

    const result = await submitBooking(payload, widgetKey);
    setLoading(false);

    if (result.ok) {
      const { data } = result;
      const params = new URLSearchParams({
        id: data.id,
        date: data.appointment_date || state.appointment_date,
        ws: data.appointment_window_start || state.appointment_window_start,
        we: data.appointment_window_end || state.appointment_window_end,
        key: widgetKey,
      });
      router.push(`/embed/scheduler/confirmation?${params.toString()}`);
    } else if (result.status === 429) {
      setError('A booking was already submitted recently with this contact info.');
    } else {
      setError(`Something went wrong. Please try again or call us at ${config.office_phone}.`);
    }
  }

  const fullAddress = [state.address_line1, state.address_line2, state.address_city, `${state.address_state} ${state.address_zip}`].filter(Boolean).join(', ');

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 0.5rem' }}>
        Review your booking
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        Please confirm everything looks correct before submitting.
      </p>

      <SummaryCard title="Service">
        <SummaryRow label="Type" value={state.service_type === 'garage_door' ? 'Garage Door' : 'Gate'} />
        <SummaryRow label="Category" value={state.service_category} />
        <SummaryRow label="Issues" value={state.issues.join(', ')} />
        <SummaryRow label="Opener" value={state.opener} />
        <SummaryRow label="Door type" value={state.door_type} />
      </SummaryCard>

      <SummaryCard title="Contact">
        <SummaryRow label="Name" value={`${state.customer_first_name} ${state.customer_last_name}`} />
        <SummaryRow label="Phone" value={formatPhoneDisplay(state.customer_phone)} />
        <SummaryRow label="Email" value={state.customer_email} />
      </SummaryCard>

      <SummaryCard title="Address">
        <SummaryRow label="Address" value={fullAddress} />
        <SummaryRow label="Property owner" value={state.address_is_owner ? 'Yes' : 'No'} />
      </SummaryCard>

      <SummaryCard title="Appointment">
        {state.appointment_date && <SummaryRow label="Date" value={formatDate(state.appointment_date)} />}
        {state.appointment_window_start && state.appointment_window_end && (
          <SummaryRow label="Time window" value={formatWindow(state.appointment_window_start, state.appointment_window_end)} />
        )}
      </SummaryCard>

      {state.description && (
        <SummaryCard title="Additional Details">
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text)', margin: 0, lineHeight: 1.5 }}>{state.description}</p>
        </SummaryCard>
      )}

      {error && (
        <div role="alert" style={{ backgroundColor: '#FEF2F2', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--radius-card)', padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <p style={{ color: 'var(--color-primary)', fontSize: '0.875rem', margin: 0 }}>{error}</p>
        </div>
      )}

      <button type="submit" onClick={handleSubmit} disabled={loading}
        style={{ width: '100%', backgroundColor: loading ? '#A01818' : 'var(--color-primary)', color: '#fff', fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: '1rem', padding: '0.875rem 1.5rem', borderRadius: 'var(--radius-input)', border: 'none', cursor: loading ? 'not-allowed' : 'pointer', minHeight: '44px', transition: 'background-color 0.15s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', opacity: loading ? 0.85 : 1 }}
      >
        {loading ? (
          <>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" style={{ animation: 'spin 0.8s linear infinite' }}>
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            Submitting...
          </>
        ) : 'Submit Booking'}
      </button>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
