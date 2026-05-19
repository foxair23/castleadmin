'use client';

interface QuestionOption {
  label: string;
  value: string;
}

interface Props {
  question: string;
  options: QuestionOption[];
  value: string | null;
  onChange: (value: string) => void;
  onNext: () => void;
}

export default function StepQuestion({ question, options, value, onChange, onNext }: Props) {
  function handleSelect(v: string) {
    onChange(v);
    // auto-advance after a short delay so the selection is visible
    setTimeout(() => onNext(), 120);
  }

  return (
    <div>
      <h2
        style={{
          fontFamily: 'var(--font-heading)',
          fontSize: '1.4rem',
          fontWeight: 700,
          color: 'var(--color-text)',
          margin: '0 0 1.25rem',
          lineHeight: 1.3,
        }}
      >
        {question}
      </h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {options.map((opt) => {
          const isSelected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={isSelected}
              onClick={() => handleSelect(opt.value)}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0.875rem 1.25rem',
                backgroundColor: isSelected ? '#FEF2F2' : 'var(--color-white)',
                border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-card)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color 0.15s, background-color 0.15s',
                minHeight: '52px',
                gap: '0.75rem',
              }}
            >
              <div
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                  backgroundColor: isSelected ? 'var(--color-primary)' : 'transparent',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'border-color 0.15s, background-color 0.15s',
                }}
              >
                {isSelected && (
                  <div
                    style={{
                      width: '7px',
                      height: '7px',
                      borderRadius: '50%',
                      backgroundColor: '#fff',
                    }}
                  />
                )}
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '1rem',
                  color: isSelected ? 'var(--color-primary)' : 'var(--color-text)',
                  fontWeight: isSelected ? 600 : 400,
                  transition: 'color 0.15s',
                }}
              >
                {opt.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
