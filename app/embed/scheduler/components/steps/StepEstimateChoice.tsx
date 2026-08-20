'use client';

import { FlowState } from '../../lib/types';

interface Props {
  state: FlowState;
  onNext: (partial: Partial<FlowState>) => void;
}

interface ChoiceOption {
  value: 'online' | 'in_person';
  emoji: string;
  label: string;
  description: string;
}

const OPTIONS: ChoiceOption[] = [
  {
    value: 'online',
    emoji: '📷',
    label: 'Free Online Estimate',
    description:
      "Send a few photos (and an optional short video) and we'll email your price — usually within 1–2 business days. No appointment needed.",
  },
  {
    value: 'in_person',
    emoji: '📅',
    label: 'Free In-Person Estimate',
    description: "Pick a time and we'll come measure and give you an exact quote on-site.",
  },
];

export default function StepEstimateChoice({ state, onNext }: Props) {
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
        Good news — this qualifies for a free estimate. How would you like to get it?
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        Choose whichever is easier for you — both are free.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {OPTIONS.map((opt) => {
          const isSelected = state.estimate_channel === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onNext({ estimate_channel: opt.value })}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.75rem',
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
              <span style={{ fontSize: '1.5rem', lineHeight: 1.2 }} aria-hidden="true">
                {opt.emoji}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column' }}>
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
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
