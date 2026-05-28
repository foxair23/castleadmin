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
  sessionId: string;
  onNext: (partial: Partial<FlowState>) => void;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

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

function formatServiceType(cat: string | null, type: string | null): string {
  const catLabel = cat === 'gate' ? 'Gate' : 'Garage Door';
  if (!type) return catLabel;
  const typeMap: Record<string, string> = {
    repairs_service: 'Repairs & Service',
    door_panel_replacement: 'Door / Panel Replacement',
    opener_service: 'Opener Service / Replacement',
    gate_opener_service: 'Gate Opener Service / Replacement',
    new_gate_replacement: 'New Gate / Gate Replacement',
  };
  return `${catLabel} — ${typeMap[type] ?? type}`;
}

function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        backgroundColor: 'var(--color-bg)',
        borderRadius: 'var(--radius-card)',
        padding: '1rem 1.25rem',
        marginBottom: '0.875rem',
      }}
    >
      <p
        style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          margin: '0 0 0.625rem',
        }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string | undefined | null }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
      <span
        style={{
          fontSize: '0.875rem',
          color: 'var(--color-text-muted)',
          minWidth: '130px',
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: '0.875rem', color: 'var(--color-text)', fontWeight: 500 }}>
        {value}
      </span>
    </div>
  );
}

const TRUST_ELEMENTS = [
  'Family-owned local company',
  'Licensed & insured',
  'CSLB #1154002',
  'Warranty-backed service',
];

export default function StepReview({ state, config, widgetKey, sessionId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (
      !state.primary_category ||
      !state.service_type ||
      !state.appointment_date ||
      !state.appointment_window_start ||
      !state.appointment_window_end
    ) {
      setError('Something is missing. Please go back and complete all steps.');
      return;
    }

    const payload: BookingPayload = {
      partial_lead_id: state.partial_lead_id ?? undefined,
      session_id: sessionId,
      first_name: state.first_name,
      mobile_phone: state.mobile_phone,
      primary_category: state.primary_category,
      service_type: state.service_type,
      answers: {
        can_open_close: state.can_open_close ?? undefined,
        estimated_age: state.estimated_age ?? undefined,
        replacement_type: state.replacement_type ?? undefined,
        multiple_doors: state.multiple_doors ?? undefined,
        opener_need: state.opener_need ?? undefined,
        gate_type: state.gate_type ?? undefined,
      },
      optional_note: state.optional_note || undefined,
      uploaded_photo_urls: state.uploaded_photo_urls.length > 0 ? state.uploaded_photo_urls : undefined,
      appointment_date: state.appointment_date,
      appointment_window_start: state.appointment_window_start,
      appointment_window_end: state.appointment_window_end,
      address_line1: state.address_line1,
      address_city: state.address_city,
      address_state: state.address_state,
      address_zip: state.address_zip,
      address_is_owner: state.address_is_owner,
      customer_email: state.customer_email || undefined,
      additional_notes: state.additional_notes || undefined,
      widget_key: widgetKey,
    };

    setLoading(true);
    setError('');

    const result = await submitBooking(payload, widgetKey);
    setLoading(false);

    if (result.ok) {
      const { data } = result;
      const params = new URLSearchParams({
        id: data.id,
        date: data.appointment_date || state.appointment_date!,
        ws: data.appointment_window_start || state.appointment_window_start!,
        we: data.appointment_window_end || state.appointment_window_end!,
        key: widgetKey,
        name: state.first_name,
      });
      router.push(`/embed/scheduler/confirmation?${params.toString()}`);
    } else if (result.status === 429) {
      setError('A booking was already submitted recently with this contact info.');
    } else {
      setError(
        result.error
          ? `Error: ${result.error}`
          : `Something went wrong. Please try again or call us at ${config.office_phone}.`
      );
    }
  }

  const fullAddress = [
    state.address_line1,
    state.address_city,
    `${state.address_state} ${state.address_zip}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div>
      <h2
        style={{
          fontFamily: 'var(--font-heading)',
          fontSize: '1.5rem',
          fontWeight: 700,
          color: 'var(--color-text)',
          margin: '0 0 0.5rem',
        }}
      >
        Review your request
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        Please confirm everything looks correct. We&apos;ll call you to confirm the appointment.
      </p>

      <SummaryCard title="Service">
        <SummaryRow label="Service" value={formatServiceType(state.primary_category, state.service_type)} />
        {state.can_open_close && (
          <SummaryRow label="Can open/close" value={state.can_open_close === 'yes' ? 'Yes' : 'No'} />
        )}
        {state.estimated_age && (
          <SummaryRow
            label="Door age"
            value={
              state.estimated_age === 'less_than_8_years'
                ? 'Less than 8 years'
                : state.estimated_age === '8_years_or_older'
                ? '8 years or older'
                : 'Not sure'
            }
          />
        )}
        {state.replacement_type && (
          <SummaryRow
            label="Looking for"
            value={
              state.replacement_type === 'basic_functional'
                ? 'Something basic and functional'
                : state.replacement_type === 'nicer_more_features'
                ? 'Something nicer with more features'
                : 'Not sure'
            }
          />
        )}
        {state.multiple_doors && (
          <SummaryRow label="Multiple doors" value={state.multiple_doors === 'yes' ? 'Yes' : 'No'} />
        )}
        {state.opener_need && (
          <SummaryRow
            label="Opener need"
            value={
              state.opener_need === 'repair_existing'
                ? 'Repair existing opener'
                : state.opener_need === 'replace'
                ? 'Replace opener'
                : state.opener_need === 'add_opener'
                ? 'Add opener to existing door/gate'
                : 'Not sure'
            }
          />
        )}
        {state.gate_type && (
          <SummaryRow
            label="Gate type"
            value={
              state.gate_type === 'swing'
                ? 'Swing gate'
                : state.gate_type === 'sliding'
                ? 'Sliding gate'
                : state.gate_type === 'pedestrian'
                ? 'Pedestrian gate'
                : 'Not sure'
            }
          />
        )}
      </SummaryCard>

      <SummaryCard title="Contact">
        <SummaryRow label="Name" value={state.first_name} />
        <SummaryRow label="Phone" value={formatPhoneDisplay(state.mobile_phone)} />
        {state.customer_email && <SummaryRow label="Email" value={state.customer_email} />}
      </SummaryCard>

      <SummaryCard title="Address">
        <SummaryRow label="Address" value={fullAddress} />
        <SummaryRow label="Property owner" value={state.address_is_owner ? 'Yes' : 'No'} />
      </SummaryCard>

      <SummaryCard title="Requested Time">
        {state.appointment_date && (
          <SummaryRow label="Date" value={formatDate(state.appointment_date)} />
        )}
        {state.appointment_window_start && state.appointment_window_end && (
          <SummaryRow
            label="Time window"
            value={formatWindow(state.appointment_window_start, state.appointment_window_end)}
          />
        )}
        <SummaryRow label="Confirmation" value="We'll call you to confirm" />
      </SummaryCard>

      {state.service_type && (() => {
        const FREE_ESTIMATE_TYPES = ['door_panel_replacement', 'new_gate_replacement']
        const isFreeEstimate = FREE_ESTIMATE_TYPES.includes(state.service_type)
        const fee = config.service_call_fee ?? 99
        return (
          <div
            style={{
              backgroundColor: isFreeEstimate ? '#F0FDF4' : '#FEF9EC',
              border: `1.5px solid ${isFreeEstimate ? '#86EFAC' : '#F5C842'}`,
              borderRadius: 'var(--radius-card)',
              padding: '0.875rem 1.25rem',
              marginBottom: '0.875rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
            }}
          >
            <span style={{ fontSize: '1.1rem' }}>{isFreeEstimate ? '✓' : 'ℹ'}</span>
            <div>
              <p style={{ margin: 0, fontWeight: 600, fontSize: '0.875rem', color: isFreeEstimate ? '#15803D' : '#856404' }}>
                {isFreeEstimate ? 'Free Estimate' : `$${fee} Service Call Fee`}
              </p>
              <p style={{ margin: 0, fontSize: '0.8rem', color: isFreeEstimate ? '#166534' : '#92671A', marginTop: '0.125rem' }}>
                {isFreeEstimate
                  ? 'No service call fee — this visit is a free estimate.'
                  : `A $${fee} diagnostic fee applies to this service call.`}
              </p>
            </div>
          </div>
        )
      })()}

      {(state.optional_note || state.additional_notes) && (
        <SummaryCard title="Notes">
          {state.optional_note && (
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text)', margin: '0 0 0.5rem', lineHeight: 1.5 }}>
              {state.optional_note}
            </p>
          )}
          {state.additional_notes && (
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text)', margin: 0, lineHeight: 1.5 }}>
              {state.additional_notes}
            </p>
          )}
        </SummaryCard>
      )}

      {/* Trust elements */}
      <div
        style={{
          border: '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-card)',
          padding: '1rem 1.25rem',
          marginBottom: '1.25rem',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {TRUST_ELEMENTS.map((item) => (
            <div key={item} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#2E7D32"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span style={{ fontSize: '0.875rem', color: 'var(--color-text)' }}>{item}</span>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            backgroundColor: '#FEF2F2',
            border: '1.5px solid var(--color-primary)',
            borderRadius: 'var(--radius-card)',
            padding: '0.875rem 1rem',
            marginBottom: '1rem',
          }}
        >
          <p style={{ color: 'var(--color-primary)', fontSize: '0.875rem', margin: 0 }}>{error}</p>
        </div>
      )}

      <button
        type="submit"
        onClick={handleSubmit}
        disabled={loading}
        style={{
          width: '100%',
          backgroundColor: loading ? 'var(--color-primary-hover)' : 'var(--color-primary)',
          color: '#fff',
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: '1rem',
          padding: '0.875rem 1.5rem',
          borderRadius: 'var(--radius-input)',
          border: 'none',
          cursor: loading ? 'not-allowed' : 'pointer',
          minHeight: '44px',
          opacity: loading ? 0.85 : 1,
          transition: 'background-color 0.15s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
        }}
        onMouseEnter={(e) => {
          if (!loading) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary-hover)';
        }}
        onMouseLeave={(e) => {
          if (!loading) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary)';
        }}
      >
        {loading ? (
          <>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden="true"
              style={{ animation: 'spin 0.8s linear infinite' }}
            >
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            Requesting…
          </>
        ) : (
          'Request Appointment'
        )}
      </button>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
