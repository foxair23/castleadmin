'use client';

import { useState } from 'react';
import { FlowState, SchedulerConfig } from '../../lib/types';
import { validatePhone, validateEmail, formatPhoneDisplay, extractDigits } from '../../lib/validation';

interface Props {
  state: FlowState;
  config: SchedulerConfig;
  onNext: (partial: Partial<FlowState>) => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.75rem 0.875rem',
  border: '1.5px solid var(--color-border)',
  borderRadius: 'var(--radius-input)',
  fontSize: '1rem',
  color: 'var(--color-text)',
  backgroundColor: 'var(--color-white)',
  fontFamily: 'var(--font-body)',
  minHeight: '44px',
  outline: 'none',
  transition: 'border-color 0.15s',
  boxSizing: 'border-box',
};

function FormField({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label
        htmlFor={id}
        style={{
          display: 'block',
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: '0.9rem',
          color: 'var(--color-text)',
          marginBottom: '0.375rem',
        }}
      >
        {label}
      </label>
      {children}
      {error && (
        <p role="alert" style={{ color: 'var(--color-primary)', fontSize: '0.8rem', marginTop: '0.3rem' }}>
          {error}
        </p>
      )}
    </div>
  );
}

export default function StepContact({ state, config, onNext }: Props) {
  const [firstName, setFirstName] = useState(state.customer_first_name);
  const [lastName, setLastName] = useState(state.customer_last_name);
  const [phoneDigits, setPhoneDigits] = useState(state.customer_phone);
  const [email, setEmail] = useState(state.customer_email);
  const [tcpa, setTcpa] = useState(state.customer_sms_appointment_consent);
  const [marketing, setMarketing] = useState(state.customer_sms_marketing_consent);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function handlePhoneChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = extractDigits(e.target.value).slice(0, 10);
    setPhoneDigits(digits);
    if (errors.phone) setErrors((prev) => ({ ...prev, phone: '' }));
  }

  function validate() {
    const errs: Record<string, string> = {};
    if (!firstName.trim()) errs.firstName = 'First name is required.';
    if (!lastName.trim()) errs.lastName = 'Last name is required.';
    if (!validatePhone(phoneDigits)) errs.phone = 'Enter a valid 10-digit US phone number.';
    if (!validateEmail(email.trim())) errs.email = 'Enter a valid email address.';
    return errs;
  }

  function handleNext() {
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    onNext({
      customer_first_name: firstName.trim(),
      customer_last_name: lastName.trim(),
      customer_phone: phoneDigits,
      customer_email: email.trim().toLowerCase(),
      customer_sms_appointment_consent: tcpa,
      customer_sms_marketing_consent: marketing,
    });
  }

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
        Your contact info
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        We'll use this to confirm your appointment.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 1rem' }}>
        <FormField id="firstName" label="First Name" error={errors.firstName}>
          <input
            id="firstName"
            type="text"
            value={firstName}
            autoComplete="given-name"
            onChange={(e) => {
              setFirstName(e.target.value);
              if (errors.firstName) setErrors((p) => ({ ...p, firstName: '' }));
            }}
            style={{
              ...inputStyle,
              borderColor: errors.firstName ? 'var(--color-primary)' : 'var(--color-border)',
            }}
            aria-describedby={errors.firstName ? 'firstName-error' : undefined}
          />
        </FormField>
        <FormField id="lastName" label="Last Name" error={errors.lastName}>
          <input
            id="lastName"
            type="text"
            value={lastName}
            autoComplete="family-name"
            onChange={(e) => {
              setLastName(e.target.value);
              if (errors.lastName) setErrors((p) => ({ ...p, lastName: '' }));
            }}
            style={{
              ...inputStyle,
              borderColor: errors.lastName ? 'var(--color-primary)' : 'var(--color-border)',
            }}
          />
        </FormField>
      </div>

      <FormField id="phone" label="Phone Number" error={errors.phone}>
        <input
          id="phone"
          type="tel"
          value={formatPhoneDisplay(phoneDigits)}
          autoComplete="tel"
          onChange={handlePhoneChange}
          placeholder="(555) 555-5555"
          style={{
            ...inputStyle,
            borderColor: errors.phone ? 'var(--color-primary)' : 'var(--color-border)',
          }}
        />
      </FormField>

      <FormField id="email" label="Email Address" error={errors.email}>
        <input
          id="email"
          type="email"
          value={email}
          autoComplete="email"
          onChange={(e) => {
            setEmail(e.target.value);
            if (errors.email) setErrors((p) => ({ ...p, email: '' }));
          }}
          placeholder="you@example.com"
          style={{
            ...inputStyle,
            borderColor: errors.email ? 'var(--color-primary)' : 'var(--color-border)',
          }}
        />
      </FormField>

      <div
        style={{
          backgroundColor: 'var(--color-bg)',
          borderRadius: 'var(--radius-card)',
          padding: '1rem',
          marginBottom: '1rem',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={tcpa}
            onChange={(e) => setTcpa(e.target.checked)}
            style={{
              width: '18px',
              height: '18px',
              accentColor: 'var(--color-primary)',
              flexShrink: 0,
              marginTop: '2px',
            }}
          />
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            {config.tcpa_copy}
          </span>
        </label>
      </div>

      <div
        style={{
          backgroundColor: 'var(--color-bg)',
          borderRadius: 'var(--radius-card)',
          padding: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={marketing}
            onChange={(e) => setMarketing(e.target.checked)}
            style={{
              width: '18px',
              height: '18px',
              accentColor: 'var(--color-primary)',
              flexShrink: 0,
              marginTop: '2px',
            }}
          />
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            {config.marketing_sms_copy}
          </span>
        </label>
      </div>

      <button
        type="button"
        onClick={handleNext}
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
          cursor: 'pointer',
          minHeight: '44px',
          transition: 'background-color 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary-hover)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary)';
        }}
      >
        Continue
      </button>
    </div>
  );
}
