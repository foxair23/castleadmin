'use client';

import { FlowState } from '../../lib/types';

interface Props {
  state: FlowState;
  onNext: (partial: Partial<FlowState>) => void;
}

interface ServiceOption {
  value: string;
  label: string;
  description: string;
}

const GD_SERVICES: ServiceOption[] = [
  {
    value: 'repairs_service',
    label: 'Repairs & Service',
    description: 'Fix a broken, noisy, or malfunctioning garage door',
  },
  {
    value: 'door_panel_replacement',
    label: 'Door / Panel Replacement',
    description: 'Replace damaged panels or the entire door',
  },
  {
    value: 'opener_service',
    label: 'Opener Service / Replacement',
    description: 'Repair or replace a garage door opener',
  },
  {
    value: 'annual_maintenance',
    label: 'Annual Maintenance',
    description: 'Tune-up, lubrication, safety inspection, and adjustments',
  },
];

const GATE_SERVICES: ServiceOption[] = [
  {
    value: 'repairs_service',
    label: 'Repairs & Service',
    description: 'Fix a broken, noisy, or malfunctioning gate',
  },
  {
    value: 'gate_opener_service',
    label: 'Gate Opener Service / Replacement',
    description: 'Repair or replace a gate opener or motor',
  },
  {
    value: 'new_gate_replacement',
    label: 'New Gate / Gate Replacement',
    description: 'Install a brand new gate or replace an existing one',
  },
  {
    value: 'annual_maintenance',
    label: 'Annual Maintenance',
    description: 'Tune-up, lubrication, safety inspection, and adjustments',
  },
];

export default function StepServiceType({ state, onNext }: Props) {
  const options = state.primary_category === 'gate' ? GATE_SERVICES : GD_SERVICES;

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
        Please select your service
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        Choose the option that best describes what you need.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {options.map((opt) => {
          const isSelected = state.service_type === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onNext({ service_type: opt.value })}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: '1rem 1.25rem',
                backgroundColor: isSelected ? '#FEF2F2' : 'var(--color-white)',
                border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-card)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color 0.15s, background-color 0.15s',
                minHeight: '44px',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontWeight: 600,
                  fontSize: '1rem',
                  color: isSelected ? 'var(--color-primary)' : 'var(--color-text)',
                  transition: 'color 0.15s',
                }}
              >
                {opt.label}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.85rem',
                  color: 'var(--color-text-muted)',
                  marginTop: '0.2rem',
                }}
              >
                {opt.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
