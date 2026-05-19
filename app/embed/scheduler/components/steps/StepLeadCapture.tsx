'use client';

import { useState } from 'react';
import { FlowState } from '../../lib/types';
import { validatePhone, formatPhoneDisplay, extractDigits } from '../../lib/validation';
import { savePartialLead } from '../../lib/api';

interface Props {
  state: FlowState;
  widgetKey: string;
  sessionId: string;
  onNext: (partial: Partial<FlowState>) => void;
}

export default function StepLeadCapture({ state, widgetKey, sessionId, onNext }: Props) {
  const [firstName, setFirstName] = useState(state.first_name);
  const [phone, setPhone] = useState(
    state.mobile_phone ? formatPhoneDisplay(state.mobile_phone) : ''
  );
  const [errors, setErrors] = useState<{ first_name?: string; mobile_phone?: string }>({});
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const errs: typeof errors = {};
    if (!firstName.trim()) errs.first_name = 'First name is required.';
    const digits = extractDigits(phone);
    if (!validatePhone(digits)) errs.mobile_phone = 'Please enter a valid 10-digit phone number.';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSubmitting(true);
    const digits = extractDigits(phone);
    const leadId = await savePartialLead({
      zip: state.zip,
      first_name: firstName.trim(),
      mobile_phone: digits,
      session_id: sessionId,
      widget_key: widgetKey,
    });
    setSubmitting(false);
    onNext({
      first_name: firstName.trim(),
      mobile_phone: digits,
      partial_lead_id: leadId,
    });
  }

  const inputStyle = (hasError: boolean): React.CSSProperties => ({
    width: '100%',
    padding: '0.75rem 1rem',
    fontSize: '1rem',
    fontFamily: 'var(--font-body)',
    border: `1.5px solid ${hasError ? 'var(--color-primary)' : 'var(--color-border)'}`,
    borderRadius: 'var(--radius-input)',
    outline: 'none',
    backgroundColor: 'var(--color-white)',
    color: 'var(--color-text)',
    boxSizing: 'border-box',
  });

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: 'var(--font-heading)',
    fontWeight: 600,
    fontSize: '0.875rem',
    color: 'var(--color-text)',
    marginBottom: '0.375rem',
  };

  const errorStyle: React.CSSProperties = {
    color: 'var(--color-primary)',
    fontSize: '0.8rem',
    marginTop: '0.25rem',
  };

  return (
    <div>
      <h2
        style={{
          fontFamily: 'var(--font-heading)',
          fontSize: '1.5rem',
          fontWeight: 700,
          color: 'var(--color-text)',
          margin: '0 0 0.375rem',
        }}
      >
        Let&apos;s get your appointment started
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        We&apos;ll only contact you about your appointment.
      </p>

      <div style={{ marginBottom: '1rem' }}>
        <label htmlFor="first-name" style={labelStyle}>
          First Name
        </label>
        <input
          id="first-name"
          type="text"
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => {
            setFirstName(e.target.value);
            setErrors((prev) => ({ ...prev, first_name: undefined }));
          }}
          placeholder="e.g. Alex"
          aria-describedby={errors.first_name ? 'fn-error' : undefined}
          style={inputStyle(!!errors.first_name)}
        />
        {errors.first_name && (
          <p id="fn-error" role="alert" style={errorStyle}>
            {errors.first_name}
          </p>
        )}
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <label htmlFor="mobile-phone" style={labelStyle}>
          Mobile Phone
        </label>
        <input
          id="mobile-phone"
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => {
            const digits = extractDigits(e.target.value).slice(0, 10);
            setPhone(formatPhoneDisplay(digits));
            setErrors((prev) => ({ ...prev, mobile_phone: undefined }));
          }}
          placeholder="(555) 555-5555"
          aria-describedby={errors.mobile_phone ? 'phone-error' : undefined}
          style={inputStyle(!!errors.mobile_phone)}
        />
        {errors.mobile_phone && (
          <p id="phone-error" role="alert" style={errorStyle}>
            {errors.mobile_phone}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting}
        style={{
          width: '100%',
          backgroundColor: 'var(--color-primary)',
          color: '#fff',
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: '1rem',
          padding: '0.875rem 1.5rem',
          borderRadius: 'var(--radius-input)',
          border: 'none',
          cursor: submitting ? 'not-allowed' : 'pointer',
          minHeight: '44px',
          opacity: submitting ? 0.85 : 1,
          transition: 'background-color 0.15s',
        }}
        onMouseEnter={(e) => {
          if (!submitting) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary-hover)';
        }}
        onMouseLeave={(e) => {
          if (!submitting) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary)';
        }}
      >
        {submitting ? 'Saving…' : 'Continue'}
      </button>
    </div>
  );
}
