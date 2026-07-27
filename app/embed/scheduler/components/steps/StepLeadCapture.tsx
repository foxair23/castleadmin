'use client';

import { useState } from 'react';
import { FlowState, SchedulerConfig } from '../../lib/types';
import { validatePhone, formatPhoneDisplay, extractDigits } from '../../lib/validation';
import { savePartialLead } from '../../lib/api';

interface Props {
  state: FlowState;
  config: SchedulerConfig;
  widgetKey: string;
  sessionId: string;
  onNext: (partial: Partial<FlowState>) => void;
}

export default function StepLeadCapture({ state, config, widgetKey, sessionId, onNext }: Props) {
  const [firstName, setFirstName] = useState(state.first_name);
  const [phone, setPhone] = useState(
    state.mobile_phone ? formatPhoneDisplay(state.mobile_phone) : ''
  );
  const [smsConsent, setSmsConsent] = useState(state.sms_consent);
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
      sms_consent: smsConsent,
      session_id: sessionId,
      widget_key: widgetKey,
    });
    setSubmitting(false);
    onNext({
      first_name: firstName.trim(),
      mobile_phone: digits,
      sms_consent: smsConsent,
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
        We&apos;ll use this to reach you about your appointment.
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

      {/* SMS opt-in — unchecked by default (TCPA/10DLC: consent must be an
          affirmative act; never pre-check). Optional — booking proceeds either
          way. The bold label is the benefit; the fine print carries the
          required disclosures (STOP/HELP, frequency, rates) and the editable
          tcpa_copy; the Privacy Policy link points at the configured legal URL. */}
      <label
        htmlFor="sms-consent"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.625rem',
          marginBottom: '1.5rem',
          cursor: 'pointer',
          padding: '0.875rem',
          border: '1.5px solid var(--color-border)',
          borderRadius: 'var(--radius-input)',
          backgroundColor: 'var(--color-white)',
        }}
      >
        <input
          id="sms-consent"
          type="checkbox"
          checked={smsConsent}
          onChange={(e) => setSmsConsent(e.target.checked)}
          style={{ width: '1.15rem', height: '1.15rem', marginTop: '0.1rem', flexShrink: 0, accentColor: 'var(--color-primary)', cursor: 'pointer' }}
        />
        <span style={{ fontSize: '0.85rem', lineHeight: 1.45, color: 'var(--color-text)' }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, display: 'block', marginBottom: '0.15rem' }}>
            Yes, keep me posted by text!
          </span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: '0.78rem' }}>
            {config.tcpa_copy}{' '}
            See our{' '}
            <a
              href={config.legal_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}
            >
              Privacy Policy
            </a>
            .
          </span>
        </span>
      </label>

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
