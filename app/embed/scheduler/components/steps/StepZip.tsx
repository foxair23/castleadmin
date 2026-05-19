'use client';

import { useState } from 'react';
import { FlowState } from '../../lib/types';
import { validateZip, extractDigits } from '../../lib/validation';

interface Props {
  state: FlowState;
  config: { office_phone: string };
  onNext: (partial: Partial<FlowState>) => void;
}

export default function StepZip({ state, config, onNext }: Props) {
  const [zip, setZip] = useState(state.zip);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  async function handleSubmit() {
    const digits = extractDigits(zip).slice(0, 5);
    if (!validateZip(digits)) {
      setError('Please enter a valid 5-digit ZIP code.');
      return;
    }
    setChecking(true);
    setError('');
    try {
      const res = await fetch(`/api/scheduler/check-zip?zip=${digits}`);
      if (!res.ok) throw new Error('network');
      const data = await res.json() as { in_service_area: boolean };
      if (!data.in_service_area) {
        setError(
          `Sorry, we don't currently service ZIP code ${digits}. Please call us at ${config.office_phone} to check availability.`
        );
        setChecking(false);
        return;
      }
      onNext({ zip: digits, service_area_valid: true });
    } catch {
      setError('Unable to verify your ZIP code. Please try again.');
    }
    setChecking(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleSubmit();
  }

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
        Enter your ZIP or postal code
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        So we can check if we service your area.
      </p>

      <div style={{ marginBottom: '1rem' }}>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={5}
          value={zip}
          onChange={(e) => {
            const d = extractDigits(e.target.value).slice(0, 5);
            setZip(d);
            setError('');
          }}
          onKeyDown={handleKeyDown}
          placeholder="e.g. 91001"
          aria-label="ZIP code"
          aria-describedby={error ? 'zip-error' : undefined}
          style={{
            width: '100%',
            padding: '0.75rem 1rem',
            fontSize: '1.1rem',
            fontFamily: 'var(--font-body)',
            border: `1.5px solid ${error ? 'var(--color-primary)' : 'var(--color-border)'}`,
            borderRadius: 'var(--radius-input)',
            outline: 'none',
            backgroundColor: 'var(--color-white)',
            color: 'var(--color-text)',
            boxSizing: 'border-box',
            letterSpacing: '0.08em',
          }}
        />
        {error && (
          <p
            id="zip-error"
            role="alert"
            style={{ color: 'var(--color-primary)', fontSize: '0.85rem', marginTop: '0.375rem' }}
          >
            {error}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={checking}
        style={{
          width: '100%',
          backgroundColor: checking ? 'var(--color-primary-hover)' : 'var(--color-primary)',
          color: '#fff',
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: '1rem',
          padding: '0.875rem 1.5rem',
          borderRadius: 'var(--radius-input)',
          border: 'none',
          cursor: checking ? 'not-allowed' : 'pointer',
          minHeight: '44px',
          opacity: checking ? 0.85 : 1,
          transition: 'background-color 0.15s',
        }}
        onMouseEnter={(e) => {
          if (!checking) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary-hover)';
        }}
        onMouseLeave={(e) => {
          if (!checking) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary)';
        }}
      >
        {checking ? 'Checking…' : 'Check My Area'}
      </button>
    </div>
  );
}
