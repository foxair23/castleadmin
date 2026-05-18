'use client';

import { useState } from 'react';
import { FlowState } from '../../lib/types';

interface Props {
  state: FlowState;
  onNext: (partial: Partial<FlowState>) => void;
}

const OPENER_OPTIONS = ['Yes', 'No', 'Not sure'];
const DOOR_TYPE_OPTIONS = ['Steel', 'Wood', 'Aluminum', 'Glass', 'Other', 'Not sure'];

function RadioGroup({
  name,
  label,
  options,
  value,
  onChange,
  error,
}: {
  name: string;
  label: string;
  options: string[];
  value: string | null;
  onChange: (val: string) => void;
  error?: string;
}) {
  return (
    <fieldset style={{ border: 'none', padding: 0, margin: '0 0 1.5rem' }}>
      <legend
        style={{
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: '1rem',
          color: 'var(--color-text)',
          marginBottom: '0.75rem',
          display: 'block',
        }}
      >
        {label}
      </legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.625rem' }}>
        {options.map((opt) => {
          const checked = value === opt;
          return (
            <label
              key={opt}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.625rem 1rem',
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
                name={name}
                value={opt}
                checked={checked}
                onChange={() => onChange(opt)}
                style={{
                  width: '16px',
                  height: '16px',
                  accentColor: 'var(--color-primary)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: '0.9rem', color: 'var(--color-text)' }}>{opt}</span>
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" style={{ color: 'var(--color-primary)', fontSize: '0.875rem', marginTop: '0.5rem' }}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

export default function StepGDUniversal({ state, onNext }: Props) {
  const [opener, setOpener] = useState<string | null>(state.opener);
  const [doorType, setDoorType] = useState<string | null>(state.door_type);
  const [errors, setErrors] = useState<{ opener?: string; door_type?: string }>({});

  function handleNext() {
    const newErrors: typeof errors = {};
    if (!opener) newErrors.opener = 'Please select an option.';
    if (!doorType) newErrors.door_type = 'Please select an option.';
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    onNext({ opener: opener!, door_type: doorType! });
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
        A few quick questions
      </h2>
      <p
        style={{
          color: 'var(--color-text-muted)',
          marginBottom: '1.5rem',
          fontSize: '0.95rem',
        }}
      >
        This helps us send the right technician.
      </p>

      <RadioGroup
        name="opener"
        label="Do you have a garage door opener?"
        options={OPENER_OPTIONS}
        value={opener}
        onChange={(v) => {
          setOpener(v);
          setErrors((e) => ({ ...e, opener: undefined }));
        }}
        error={errors.opener}
      />

      <RadioGroup
        name="door_type"
        label="Type of door?"
        options={DOOR_TYPE_OPTIONS}
        value={doorType}
        onChange={(v) => {
          setDoorType(v);
          setErrors((e) => ({ ...e, door_type: undefined }));
        }}
        error={errors.door_type}
      />

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
