'use client';

interface ProgressBarProps {
  currentStep: number;
  totalSteps: number;
}

export default function ProgressBar({ currentStep, totalSteps }: ProgressBarProps) {
  return (
    <div
      role="progressbar"
      aria-valuenow={currentStep}
      aria-valuemin={1}
      aria-valuemax={totalSteps}
      aria-label={`Step ${currentStep} of ${totalSteps}`}
      style={{
        display: 'flex',
        gap: '6px',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem 0 0.5rem',
      }}
    >
      {Array.from({ length: totalSteps }, (_, i) => {
        const step = i + 1;
        const isCompleted = step < currentStep;
        const isCurrent = step === currentStep;
        return (
          <div
            key={step}
            style={{
              width: isCurrent ? '24px' : '8px',
              height: '8px',
              borderRadius: '4px',
              backgroundColor: isCompleted || isCurrent
                ? 'var(--color-primary)'
                : 'var(--color-border)',
              transition: 'width 0.2s ease, background-color 0.2s ease',
            }}
          />
        );
      })}
    </div>
  );
}
