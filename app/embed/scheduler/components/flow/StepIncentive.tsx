'use client';

import { FlowState, SchedulerConfig } from '../../lib/types';

interface Props {
  state: FlowState;
  config: SchedulerConfig;
  onNext: (partial: Partial<FlowState>) => void;
}

export default function StepIncentive({ config, onNext }: Props) {
  return (
    <div>
      <div
        style={{
          backgroundColor: 'var(--color-primary)',
          borderRadius: 'var(--radius-large)',
          padding: '2rem 1.5rem',
          textAlign: 'center',
          marginBottom: '2rem',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <div
          style={{
            width: '52px',
            height: '52px',
            borderRadius: '50%',
            backgroundColor: 'rgba(255,255,255,0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1rem',
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </div>
        <p
          style={{
            color: 'rgba(255,255,255,0.85)',
            fontSize: '0.875rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            margin: '0 0 0.5rem',
          }}
        >
          Special Offer
        </p>
        <p
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: '2rem',
            color: '#fff',
            margin: '0 0 0.75rem',
            lineHeight: 1.1,
          }}
        >
          {config.incentive_banner_text}
        </p>
        <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: '0.9rem', margin: 0 }}>
          Applied automatically to your first service with us.
        </p>
      </div>

      <button
        type="button"
        onClick={() => onNext({})}
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
        Continue to Review
      </button>
    </div>
  );
}
