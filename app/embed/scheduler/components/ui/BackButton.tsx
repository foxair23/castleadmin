'use client';

interface BackButtonProps {
  onClick: () => void;
}

export default function BackButton({ onClick }: BackButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Go back"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.375rem',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'var(--color-text-muted)',
        fontFamily: 'var(--font-heading)',
        fontWeight: 500,
        fontSize: '0.9rem',
        padding: '0.5rem 0',
        minHeight: '44px',
        transition: 'color 0.15s',
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10 12L6 8l4-4" />
      </svg>
      Back
    </button>
  );
}
