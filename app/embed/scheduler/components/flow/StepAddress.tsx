'use client';

import { useState } from 'react';
import { FlowState } from '../../lib/types';
import { validateZip } from '../../lib/validation';

interface Props {
  state: FlowState;
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
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
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
        {!required && (
          <span style={{ fontWeight: 400, color: 'var(--color-text-muted)', marginLeft: '0.375rem', fontSize: '0.8rem' }}>
            (optional)
          </span>
        )}
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

export default function StepAddress({ state, onNext }: Props) {
  const [line1, setLine1] = useState(state.address_line1);
  const [line2, setLine2] = useState(state.address_line2);
  const [city, setCity] = useState(state.address_city);
  const [addressState, setAddressState] = useState(state.address_state || 'CA');
  const [zip, setZip] = useState(state.address_zip);
  const [isOwner, setIsOwner] = useState<boolean>(state.address_is_owner);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate() {
    const errs: Record<string, string> = {};
    if (!line1.trim()) errs.line1 = 'Street address is required.';
    if (!city.trim()) errs.city = 'City is required.';
    if (!addressState.trim()) errs.state = 'State is required.';
    if (!validateZip(zip.trim())) errs.zip = 'Enter a valid 5-digit ZIP code.';
    return errs;
  }

  function handleNext() {
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    onNext({
      address_line1: line1.trim(),
      address_line2: line2.trim(),
      address_city: city.trim(),
      address_state: addressState.trim(),
      address_zip: zip.trim(),
      address_is_owner: isOwner,
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
        Service address
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        Where should we send our technician?
      </p>

      <FormField id="line1" label="Street Address" required error={errors.line1}>
        <input
          id="line1"
          type="text"
          value={line1}
          autoComplete="address-line1"
          onChange={(e) => {
            setLine1(e.target.value);
            if (errors.line1) setErrors((p) => ({ ...p, line1: '' }));
          }}
          style={{ ...inputStyle, borderColor: errors.line1 ? 'var(--color-primary)' : 'var(--color-border)' }}
        />
      </FormField>

      <FormField id="line2" label="Apt, Suite, Unit" error={errors.line2}>
        <input
          id="line2"
          type="text"
          value={line2}
          autoComplete="address-line2"
          onChange={(e) => setLine2(e.target.value)}
          style={inputStyle}
        />
      </FormField>

      <FormField id="city" label="City" required error={errors.city}>
        <input
          id="city"
          type="text"
          value={city}
          autoComplete="address-level2"
          onChange={(e) => {
            setCity(e.target.value);
            if (errors.city) setErrors((p) => ({ ...p, city: '' }));
          }}
          style={{ ...inputStyle, borderColor: errors.city ? 'var(--color-primary)' : 'var(--color-border)' }}
        />
      </FormField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 1rem' }}>
        <FormField id="addrState" label="State" required error={errors.state}>
          <input
            id="addrState"
            type="text"
            value={addressState}
            autoComplete="address-level1"
            maxLength={2}
            onChange={(e) => {
              setAddressState(e.target.value.toUpperCase());
              if (errors.state) setErrors((p) => ({ ...p, state: '' }));
            }}
            style={{ ...inputStyle, borderColor: errors.state ? 'var(--color-primary)' : 'var(--color-border)' }}
          />
        </FormField>
        <FormField id="zip" label="ZIP Code" required error={errors.zip}>
          <input
            id="zip"
            type="text"
            value={zip}
            autoComplete="postal-code"
            maxLength={5}
            onChange={(e) => {
              setZip(e.target.value.replace(/\D/g, '').slice(0, 5));
              if (errors.zip) setErrors((p) => ({ ...p, zip: '' }));
            }}
            style={{ ...inputStyle, borderColor: errors.zip ? 'var(--color-primary)' : 'var(--color-border)' }}
            placeholder="90210"
          />
        </FormField>
      </div>

      <fieldset style={{ border: 'none', padding: 0, margin: '0 0 1.5rem' }}>
        <legend
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 600,
            fontSize: '0.9rem',
            color: 'var(--color-text)',
            marginBottom: '0.75rem',
            display: 'block',
          }}
        >
          Are you the property owner?
        </legend>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          {[true, false].map((val) => {
            const label = val ? 'Yes' : 'No';
            const checked = isOwner === val;
            return (
              <label
                key={label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.625rem 1.25rem',
                  backgroundColor: checked ? '#FEF2F2' : 'var(--color-white)',
                  border: `2px solid ${checked ? 'var(--color-primary)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-input)',
                  cursor: 'pointer',
                  minHeight: '44px',
                  transition: 'border-color 0.15s, background-color 0.15s',
                }}
              >
                <input
                  type="radio"
                  name="isOwner"
                  value={label}
                  checked={checked}
                  onChange={() => setIsOwner(val)}
                  style={{ width: '16px', height: '16px', accentColor: 'var(--color-primary)', cursor: 'pointer' }}
                />
                <span style={{ fontSize: '0.9rem', color: 'var(--color-text)' }}>{label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

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
