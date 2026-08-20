'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlowState, SchedulerConfig, OnlineEstimatePayload } from '../../lib/types';
import { submitOnlineEstimate } from '../../lib/api';
import { clearFlowState } from '../../lib/storage';
import { formatPhoneDisplay } from '../../lib/validation';
import { ONLINE_ESTIMATE_DISCLAIMER, ONLINE_ESTIMATE_TURNAROUND } from '../../lib/online-estimate';

interface Props {
  state: FlowState;
  config: SchedulerConfig;
  widgetKey: string;
  sessionId: string;
  onNext: (partial: Partial<FlowState>) => void;
}

function serviceLabel(state: FlowState): string {
  if (state.service_type === 'door_panel_replacement') return 'Garage Door — New Door / Panel';
  if (state.service_type === 'opener_service') {
    const need = state.opener_need === 'add_opener' ? 'Add Opener' : 'Replace Opener';
    return `Garage Door Opener — ${need}`;
  }
  return 'Garage Door';
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ backgroundColor: 'var(--color-bg)', borderRadius: 'var(--radius-card)', padding: '1rem 1.25rem', marginBottom: '0.875rem' }}>
      <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.625rem' }}>{title}</p>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | undefined | null }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
      <span style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)', minWidth: '110px', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '0.875rem', color: 'var(--color-text)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

export default function StepOnlineEstimateReview({ state, config, widgetKey, sessionId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const photoCount = state.estimate_media.filter((m) => m.kind === 'photo').length;
  const videoCount = state.estimate_media.filter((m) => m.kind === 'video').length;

  async function handleSubmit() {
    if (!state.primary_category || !state.service_type || !state.customer_email) {
      setError('Something is missing. Please go back and complete all steps.');
      return;
    }
    const payload: OnlineEstimatePayload = {
      partial_lead_id: state.partial_lead_id ?? undefined,
      session_id: sessionId,
      first_name: state.first_name,
      last_name: state.customer_last_name || undefined,
      mobile_phone: state.mobile_phone,
      sms_consent: state.sms_consent,
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
      address_line1: state.address_line1,
      address_city: state.address_city,
      address_state: state.address_state,
      address_zip: state.address_zip,
      address_is_owner: state.address_is_owner,
      customer_email: state.customer_email.trim(),
      additional_notes: state.additional_notes || undefined,
      widget_key: widgetKey,
    };

    setLoading(true);
    setError('');
    const result = await submitOnlineEstimate(payload, widgetKey);
    setLoading(false);

    if (result.ok) {
      const params = new URLSearchParams({
        id: result.id,
        key: widgetKey,
        name: state.first_name,
        email: state.customer_email.trim(),
        estimate: '1',
      });
      clearFlowState();
      router.push(`/embed/scheduler/confirmation?${params.toString()}`);
    } else {
      setError(result.error ? `Error: ${result.error}` : `Something went wrong. Please try again or call us at ${config.office_phone}.`);
    }
  }

  const fullAddress = [state.address_line1, state.address_city, `${state.address_state} ${state.address_zip}`].filter(Boolean).join(', ');
  const mediaSummary = [
    photoCount > 0 ? `${photoCount} photo${photoCount === 1 ? '' : 's'}` : null,
    videoCount > 0 ? `${videoCount} video` : null,
  ].filter(Boolean).join(' + ') || 'None added';

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 0.5rem' }}>
        Review your online estimate request
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        We&apos;ll review your photos and email your estimate {ONLINE_ESTIMATE_TURNAROUND}.
      </p>

      <Card title="Service">
        <Row label="Service" value={serviceLabel(state)} />
        {state.replacement_type && (
          <Row label="Looking for" value={state.replacement_type === 'basic_functional' ? 'Something basic and functional' : state.replacement_type === 'nicer_more_features' ? 'Something nicer with more features' : 'Not sure'} />
        )}
        {state.multiple_doors && <Row label="Multiple doors" value={state.multiple_doors === 'yes' ? 'Yes' : 'No'} />}
      </Card>

      <Card title="Contact">
        <Row label="Name" value={[state.first_name, state.customer_last_name].filter(Boolean).join(' ')} />
        <Row label="Phone" value={formatPhoneDisplay(state.mobile_phone)} />
        <Row label="Email" value={state.customer_email} />
      </Card>

      <Card title="Address">
        <Row label="Address" value={fullAddress} />
        <Row label="Property owner" value={state.address_is_owner ? 'Yes' : 'No'} />
      </Card>

      <Card title="Photos & Video">
        <Row label="Attached" value={mediaSummary} />
      </Card>

      {(state.optional_note || state.additional_notes) && (
        <Card title="Notes">
          {state.optional_note && <p style={{ fontSize: '0.875rem', color: 'var(--color-text)', margin: '0 0 0.5rem', lineHeight: 1.5 }}>{state.optional_note}</p>}
          {state.additional_notes && <p style={{ fontSize: '0.875rem', color: 'var(--color-text)', margin: 0, lineHeight: 1.5 }}>{state.additional_notes}</p>}
        </Card>
      )}

      <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
        {ONLINE_ESTIMATE_DISCLAIMER}
      </p>

      {error && (
        <div role="alert" style={{ backgroundColor: '#FEF2F2', border: '1.5px solid var(--color-primary)', borderRadius: 'var(--radius-card)', padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <p style={{ color: 'var(--color-primary)', fontSize: '0.875rem', margin: 0 }}>{error}</p>
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading}
        style={{
          width: '100%', backgroundColor: 'var(--color-primary)', color: '#fff', fontFamily: 'var(--font-heading)',
          fontWeight: 600, fontSize: '1rem', padding: '0.875rem 1.5rem', borderRadius: 'var(--radius-input)',
          border: 'none', cursor: loading ? 'not-allowed' : 'pointer', minHeight: '44px', opacity: loading ? 0.85 : 1,
        }}
      >
        {loading ? 'Submitting…' : 'Submit for Online Estimate'}
      </button>
    </div>
  );
}
