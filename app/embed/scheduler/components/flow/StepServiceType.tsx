'use client';

import ServiceCard from '../ui/ServiceCard';
import { FlowState } from '../../lib/types';

interface Props {
  state: FlowState;
  onNext: (partial: Partial<FlowState>) => void;
  onGateComing: () => void;
}

export default function StepServiceType({ onNext, onGateComing }: Props) {
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
        What can we help you with?
      </h2>
      <p
        style={{
          color: 'var(--color-text-muted)',
          marginBottom: '1.5rem',
          fontSize: '0.95rem',
        }}
      >
        Select the type of service you need.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <ServiceCard
          label="Garage Door"
          description="Repair, installation, maintenance, and more"
          onClick={() => onNext({ service_type: 'garage_door' })}
          icon={
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="18" rx="1" />
              <line x1="2" y1="9" x2="22" y2="9" />
              <line x1="2" y1="15" x2="22" y2="15" />
              <line x1="8" y1="3" x2="8" y2="21" />
              <line x1="16" y1="3" x2="16" y2="21" />
            </svg>
          }
        />
        <ServiceCard
          label="Gate"
          description="Driveway gates, entry gates, and automation"
          onClick={onGateComing}
          icon={
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 21V7l9-4 9 4v14" />
              <line x1="12" y1="3" x2="12" y2="21" />
              <rect x="5" y="9" width="4" height="6" />
              <rect x="15" y="9" width="4" height="6" />
            </svg>
          }
        />
      </div>
    </div>
  );
}
