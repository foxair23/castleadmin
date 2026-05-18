'use client';

interface ServiceCardProps {
  label: string;
  description?: string;
  selected?: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}

export default function ServiceCard({
  label,
  description,
  selected,
  onClick,
  icon,
}: ServiceCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '0.5rem',
        padding: '1.25rem 1.25rem',
        backgroundColor: selected ? '#FEF2F2' : 'var(--color-white)',
        border: `2px solid ${selected ? 'var(--color-primary)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-large)',
        boxShadow: 'var(--shadow-card)',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        minHeight: '80px',
        transition: 'border-color 0.15s ease, background-color 0.15s ease',
      }}
    >
      {icon && (
        <span aria-hidden="true" style={{ fontSize: '1.5rem', lineHeight: 1 }}>
          {icon}
        </span>
      )}
      <span
        style={{
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: '1.05rem',
          color: selected ? 'var(--color-primary)' : 'var(--color-text)',
        }}
      >
        {label}
      </span>
      {description && (
        <span
          style={{
            fontSize: '0.875rem',
            color: 'var(--color-text-muted)',
            lineHeight: 1.4,
          }}
        >
          {description}
        </span>
      )}
    </button>
  );
}
