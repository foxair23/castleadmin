'use client';

import { FlowState, PrimaryCategory } from '../../lib/types';

interface Props {
  state: FlowState;
  onNext: (partial: Partial<FlowState>) => void;
}

interface CategoryOption {
  value: PrimaryCategory;
  label: string;
  icon: React.ReactNode;
  description: string;
}

const GARAGE_DOOR_ICON = (
  <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <rect x="4" y="10" width="40" height="30" rx="3" stroke="currentColor" strokeWidth="2.5" fill="none" />
    <line x1="4" y1="20" x2="44" y2="20" stroke="currentColor" strokeWidth="2" />
    <line x1="4" y1="28" x2="44" y2="28" stroke="currentColor" strokeWidth="2" />
    <line x1="14" y1="10" x2="14" y2="40" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
    <line x1="34" y1="10" x2="34" y2="40" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
    <circle cx="24" cy="34" r="2" fill="currentColor" />
  </svg>
);

const GATE_ICON = (
  <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <rect x="3" y="8" width="19" height="32" rx="2" stroke="currentColor" strokeWidth="2.5" fill="none" />
    <rect x="26" y="8" width="19" height="32" rx="2" stroke="currentColor" strokeWidth="2.5" fill="none" />
    <line x1="3" y1="24" x2="22" y2="24" stroke="currentColor" strokeWidth="2" />
    <line x1="26" y1="24" x2="45" y2="24" stroke="currentColor" strokeWidth="2" />
    <line x1="8" y1="8" x2="8" y2="40" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
    <line x1="15" y1="8" x2="15" y2="40" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
    <line x1="33" y1="8" x2="33" y2="40" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
    <line x1="40" y1="8" x2="40" y2="40" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
    <circle cx="22" cy="24" r="2" fill="currentColor" />
    <circle cx="26" cy="24" r="2" fill="currentColor" />
  </svg>
);

const CATEGORIES: CategoryOption[] = [
  {
    value: 'garage_door',
    label: 'Garage Door',
    description: 'Repairs, replacement, opener service',
    icon: GARAGE_DOOR_ICON,
  },
  {
    value: 'gate',
    label: 'Gate',
    description: 'Repairs, opener service, new gate installation',
    icon: GATE_ICON,
  },
];

export default function StepServiceCategory({ state, onNext }: Props) {
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
        What do you need help with?
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        Select a category to get started.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        {CATEGORIES.map((cat) => {
          const isSelected = state.primary_category === cat.value;
          return (
            <button
              key={cat.value}
              type="button"
              aria-pressed={isSelected}
              onClick={() =>
                onNext({ primary_category: cat.value, service_type: null })
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1.25rem',
                padding: '1.25rem 1.25rem',
                backgroundColor: isSelected ? '#FEF2F2' : 'var(--color-white)',
                border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-card)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color 0.15s, background-color 0.15s',
                minHeight: '80px',
              }}
            >
              <div
                style={{
                  color: isSelected ? 'var(--color-primary)' : 'var(--color-text-muted)',
                  flexShrink: 0,
                  transition: 'color 0.15s',
                }}
              >
                {cat.icon}
              </div>
              <div>
                <p
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 700,
                    fontSize: '1.1rem',
                    color: isSelected ? 'var(--color-primary)' : 'var(--color-text)',
                    margin: '0 0 0.2rem',
                    transition: 'color 0.15s',
                  }}
                >
                  {cat.label}
                </p>
                <p
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.875rem',
                    color: 'var(--color-text-muted)',
                    margin: 0,
                  }}
                >
                  {cat.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
