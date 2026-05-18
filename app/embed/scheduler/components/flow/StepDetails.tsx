'use client';

import { useState } from 'react';
import { FlowState } from '../../lib/types';

interface Props {
  state: FlowState;
  onNext: (partial: Partial<FlowState>) => void;
}

const MAX_CHARS = 1000;

export default function StepDetails({ state, onNext }: Props) {
  const [description, setDescription] = useState(state.description || '');

  function handleNext() {
    onNext({ description: description.trim() });
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
        Any additional details?
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        Optional — tell us more to help our technician prepare.
      </p>

      <div style={{ marginBottom: '1.25rem' }}>
        <label
          htmlFor="description"
          style={{
            display: 'block',
            fontFamily: 'var(--font-heading)',
            fontWeight: 600,
            fontSize: '0.9rem',
            color: 'var(--color-text)',
            marginBottom: '0.375rem',
          }}
        >
          Tell us more about the issue
          <span style={{ fontWeight: 400, color: 'var(--color-text-muted)', marginLeft: '0.375rem', fontSize: '0.8rem' }}>
            (optional)
          </span>
        </label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => {
            if (e.target.value.length <= MAX_CHARS) setDescription(e.target.value);
          }}
          rows={5}
          placeholder="Describe what you're experiencing..."
          style={{
            width: '100%',
            padding: '0.75rem 0.875rem',
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-input)',
            fontSize: '1rem',
            color: 'var(--color-text)',
            backgroundColor: 'var(--color-white)',
            fontFamily: 'var(--font-body)',
            resize: 'vertical',
            outline: 'none',
            boxSizing: 'border-box',
            lineHeight: 1.5,
          }}
        />
        <p
          style={{
            fontSize: '0.78rem',
            color: description.length >= MAX_CHARS ? 'var(--color-primary)' : 'var(--color-text-muted)',
            textAlign: 'right',
            marginTop: '0.25rem',
          }}
        >
          {description.length}/{MAX_CHARS}
        </p>
      </div>

      <div
        style={{
          backgroundColor: 'var(--color-bg)',
          borderRadius: 'var(--radius-card)',
          padding: '1rem 1.25rem',
          marginBottom: '1.5rem',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.75rem',
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-text-muted)"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0, marginTop: '1px' }}
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)', margin: 0, lineHeight: 1.5 }}>
          Photo upload coming soon — you can share photos when we call to confirm your appointment.
        </p>
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
