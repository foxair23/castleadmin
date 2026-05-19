'use client';

import { useState } from 'react';
import { FlowState } from '../../lib/types';

interface Props {
  state: FlowState;
  onNext: (partial: Partial<FlowState>) => void;
}

export default function StepPropertyDetails({ state, onNext }: Props) {
  const [addressLine1, setAddressLine1] = useState(state.address_line1);
  const [city, setCity] = useState(state.address_city);
  const [stateAbbr, setStateAbbr] = useState(state.address_state || 'CA');
  const [zip, setZip] = useState(state.address_zip || state.zip);
  const [isOwner, setIsOwner] = useState(state.address_is_owner);
  const [email, setEmail] = useState(state.customer_email);
  const [additionalNotes, setAdditionalNotes] = useState(state.additional_notes);
  const [errors, setErrors] = useState<{ address_line1?: string; city?: string; state?: string; zip?: string }>({});

  function validate(): boolean {
    const errs: typeof errors = {};
    if (!addressLine1.trim()) errs.address_line1 = 'Street address is required.';
    if (!city.trim()) errs.city = 'City is required.';
    if (!stateAbbr.trim()) errs.state = 'State is required.';
    if (!zip.trim()) errs.zip = 'ZIP code is required.';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit() {
    if (!validate()) return;
    onNext({
      address_line1: addressLine1.trim(),
      address_city: city.trim(),
      address_state: stateAbbr.trim(),
      address_zip: zip.trim(),
      address_is_owner: isOwner,
      customer_email: email.trim(),
      additional_notes: additionalNotes.trim(),
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

  const fieldStyle: React.CSSProperties = { marginBottom: '1rem' };

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
        Where do you need service?
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        We&apos;ll use this address for your appointment.
      </p>

      <div style={fieldStyle}>
        <label htmlFor="address-line1" style={labelStyle}>
          Street Address <span style={{ color: 'var(--color-primary)' }}>*</span>
        </label>
        <input
          id="address-line1"
          type="text"
          autoComplete="address-line1"
          value={addressLine1}
          onChange={(e) => {
            setAddressLine1(e.target.value);
            setErrors((prev) => ({ ...prev, address_line1: undefined }));
          }}
          placeholder="123 Main St"
          style={inputStyle(!!errors.address_line1)}
        />
        {errors.address_line1 && <p role="alert" style={errorStyle}>{errors.address_line1}</p>}
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
        <div style={{ flex: 2 }}>
          <label htmlFor="city" style={labelStyle}>
            City <span style={{ color: 'var(--color-primary)' }}>*</span>
          </label>
          <input
            id="city"
            type="text"
            autoComplete="address-level2"
            value={city}
            onChange={(e) => {
              setCity(e.target.value);
              setErrors((prev) => ({ ...prev, city: undefined }));
            }}
            placeholder="Los Angeles"
            style={inputStyle(!!errors.city)}
          />
          {errors.city && <p role="alert" style={errorStyle}>{errors.city}</p>}
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="state-abbr" style={labelStyle}>
            State <span style={{ color: 'var(--color-primary)' }}>*</span>
          </label>
          <input
            id="state-abbr"
            type="text"
            autoComplete="address-level1"
            maxLength={2}
            value={stateAbbr}
            onChange={(e) => {
              setStateAbbr(e.target.value.toUpperCase());
              setErrors((prev) => ({ ...prev, state: undefined }));
            }}
            placeholder="CA"
            style={inputStyle(!!errors.state)}
          />
          {errors.state && <p role="alert" style={errorStyle}>{errors.state}</p>}
        </div>
      </div>

      <div style={fieldStyle}>
        <label htmlFor="zip-code" style={labelStyle}>
          ZIP Code <span style={{ color: 'var(--color-primary)' }}>*</span>
        </label>
        <input
          id="zip-code"
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={5}
          value={zip}
          onChange={(e) => {
            setZip(e.target.value.replace(/\D/g, '').slice(0, 5));
            setErrors((prev) => ({ ...prev, zip: undefined }));
          }}
          placeholder="91001"
          style={inputStyle(!!errors.zip)}
        />
        {errors.zip && <p role="alert" style={errorStyle}>{errors.zip}</p>}
      </div>

      <div style={fieldStyle}>
        <label htmlFor="customer-email" style={labelStyle}>
          Email <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span>
        </label>
        <input
          id="customer-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          style={inputStyle(false)}
        />
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.625rem',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={isOwner}
            onChange={(e) => setIsOwner(e.target.checked)}
            style={{
              width: '18px',
              height: '18px',
              marginTop: '1px',
              accentColor: 'var(--color-primary)',
              flexShrink: 0,
              cursor: 'pointer',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '0.9rem',
              color: 'var(--color-text)',
            }}
          >
            I am the property owner
          </span>
        </label>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <label htmlFor="additional-notes" style={labelStyle}>
          Additional Notes <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span>
        </label>
        <textarea
          id="additional-notes"
          value={additionalNotes}
          onChange={(e) => setAdditionalNotes(e.target.value)}
          rows={3}
          placeholder="Gate code, parking instructions, etc."
          style={{
            width: '100%',
            padding: '0.75rem 1rem',
            fontSize: '0.95rem',
            fontFamily: 'var(--font-body)',
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-input)',
            outline: 'none',
            resize: 'vertical',
            backgroundColor: 'var(--color-white)',
            color: 'var(--color-text)',
            boxSizing: 'border-box',
          }}
        />
      </div>

      <button
        type="button"
        onClick={handleSubmit}
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
