'use client';

import ServiceCard from '../ui/ServiceCard';
import { FlowState, SchedulerConfig } from '../../lib/types';

interface Props {
  state: FlowState;
  config: SchedulerConfig;
  onNext: (partial: Partial<FlowState>) => void;
}

export default function StepGDCategory({ state, config, onNext }: Props) {
  const categories = config.garage_door_categories;

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
        What type of service do you need?
      </h2>
      <p
        style={{
          color: 'var(--color-text-muted)',
          marginBottom: '1.5rem',
          fontSize: '0.95rem',
        }}
      >
        Choose the category that best fits your situation.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        {categories.map((cat) => (
          <ServiceCard
            key={cat}
            label={cat}
            selected={state.service_category === cat}
            onClick={() => onNext({ service_category: cat })}
          />
        ))}
      </div>
    </div>
  );
}
