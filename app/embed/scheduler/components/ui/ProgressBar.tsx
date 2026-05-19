'use client';

interface ProgressBarProps {
  currentSection: number;
  totalSections: number;
  labels: string[];
}

export default function ProgressBar({ currentSection, totalSections, labels }: ProgressBarProps) {
  return (
    <div
      role="progressbar"
      aria-valuenow={currentSection}
      aria-valuemin={1}
      aria-valuemax={totalSections}
      aria-label={`Section ${currentSection} of ${totalSections}: ${labels[currentSection - 1] ?? ''}`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        gap: '0',
        padding: '1rem 0 0.75rem',
        overflowX: 'auto',
      }}
    >
      {Array.from({ length: totalSections }, (_, i) => {
        const section = i + 1;
        const isCompleted = section < currentSection;
        const isCurrent = section === currentSection;
        const isLast = section === totalSections;
        return (
          <div
            key={section}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              flex: isLast ? '0 0 auto' : '1 1 0',
              minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
              {/* dot */}
              <div
                style={{
                  flexShrink: 0,
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor:
                    isCompleted || isCurrent ? 'var(--color-primary)' : 'var(--color-border)',
                  transition: 'background-color 0.2s ease',
                  zIndex: 1,
                }}
              />
              {/* connector line */}
              {!isLast && (
                <div
                  style={{
                    flex: 1,
                    height: '2px',
                    backgroundColor: isCompleted ? 'var(--color-primary)' : 'var(--color-border)',
                    transition: 'background-color 0.2s ease',
                  }}
                />
              )}
            </div>
            {/* label */}
            <span
              style={{
                fontSize: '0.65rem',
                fontFamily: 'var(--font-body)',
                fontWeight: isCurrent ? 600 : 400,
                color: isCompleted || isCurrent ? 'var(--color-text)' : 'var(--color-text-muted)',
                marginTop: '0.3rem',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '56px',
                textAlign: 'center',
              }}
            >
              {labels[i]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
