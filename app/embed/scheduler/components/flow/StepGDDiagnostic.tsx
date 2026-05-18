'use client';

import { useState } from 'react';
import { FlowState, SchedulerConfig } from '../../lib/types';

interface Props {
  state: FlowState;
  config: SchedulerConfig;
  onNext: (partial: Partial<FlowState>) => void;
}

const NONE_OPTION = 'None of the above / Not sure';

export default function StepGDDiagnostic({ state, config, onNext }: Props) {
  const [selected, setSelected] = useState<string[]>(state.issues || []);
  const [error, setError] = useState('');

  const issues = config.garage_door_issues;

  function toggle(issue: string) {
    setError('');
    if (issue === NONE_OPTION) {
      setSelected([NONE_OPTION]);
      return;
    }
    setSelected((prev) => {
      const without = prev.filter((i) => i !== NONE_OPTION);
      if (without.includes(issue)) {
        return without.filter((i) => i !== issue);
      }
      return [...without, issue];
    });
  }

  function handleNext() {
    if (selected.length === 0) {
      setError('Please select at least one option.');
      return;
    }
    onNext({ issues: selected });
  }

  const allOptions = [...issues, NONE_OPTION];

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
        What issues are you experiencing?
      </h2>
      <p
        style={{
          color: 'var(--color-text-muted)',
          marginBottom: '1.25rem',
          fontSize: '0.95rem',
        }}
      >
        Select all that apply.
      </p>
      <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="sr-only">Garage door issues</legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {allOptions.map((issue) => {
            const checked = selected.includes(issue);
            return (
              <label
                key={issue}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.875rem 1rem',
                  backgroundColor: checked ? '#FEF2F2' : 'var(--color-white)',
                  border: `2px solid ${checked ? 'var(--color-primary)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-card)',
                  cursor: 'pointer',
                  minHeight: '44px',
                  transition: 'border-color 0.15s, background-color 0.15s',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(issue)}
                  style={{
                    width: '18px',
                    height: '18px',
                    accentColor: 'var(--color-primary)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontFamily: issue === NONE_OPTION ? 'var(--font-body)' : 'var(--font-body)',
                    fontSize: '0.95rem',
                    color: checked ? 'var(--color-text)' : 'var(--color-text)',
                    fontStyle: issue === NONE_OPTION ? 'italic' : 'normal',
                  }}
                >
                  {issue}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {error && (
        <p
          role="alert"
          style={{
            color: 'var(--color-primary)',
            fontSize: '0.875rem',
            marginTop: '0.75rem',
          }}
        >
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handleNext}
        style={{
          marginTop: '1.5rem',
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
