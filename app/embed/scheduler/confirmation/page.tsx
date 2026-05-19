'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, Suspense } from 'react';
import { clearFlowState } from '../lib/storage';
import Link from 'next/link';

function formatAppointmentDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatWindow(start: string, end: string): string {
  function fmt(t: string): string {
    const [h, m] = t.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? `${hour} ${period}` : `${hour}:${String(m).padStart(2, '0')} ${period}`;
  }
  return `${fmt(start)} – ${fmt(end)}`;
}

// Hardcoded phone — config is no longer fetched client-side on confirmation
const OFFICE_PHONE = '(800) 576-1397';
const OFFICE_PHONE_DIGITS = '8005761397';

function ConfirmationContent() {
  const params = useSearchParams();
  const id = params.get('id');
  const date = params.get('date');
  const ws = params.get('ws');
  const we = params.get('we');
  const widgetKey = params.get('key') ?? '';
  const firstName = params.get('name') ?? '';

  useEffect(() => {
    clearFlowState();
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--color-bg)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '2rem 1rem',
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--color-white)',
          borderRadius: 'var(--radius-large)',
          boxShadow: 'var(--shadow-card)',
          padding: '2.5rem 2rem',
          maxWidth: '520px',
          width: '100%',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            backgroundColor: '#E8F5E9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1.5rem',
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#2E7D32"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <h1
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: '1.75rem',
            fontWeight: 700,
            color: 'var(--color-text)',
            margin: '0 0 0.5rem',
          }}
        >
          {firstName ? `You're all set, ${firstName}!` : "You're all set!"}
        </h1>
        <p
          style={{
            color: 'var(--color-text-muted)',
            margin: '0 0 2rem',
            fontSize: '1rem',
          }}
        >
          Your appointment is confirmed. We&apos;ll see you soon.
        </p>

        {id && (
          <div
            style={{
              backgroundColor: 'var(--color-bg)',
              borderRadius: 'var(--radius-card)',
              padding: '1rem 1.25rem',
              marginBottom: '1rem',
              textAlign: 'left',
            }}
          >
            <p
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'var(--color-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                margin: '0 0 0.25rem',
              }}
            >
              Booking ID
            </p>
            <p
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: '1.1rem',
                fontWeight: 700,
                color: 'var(--color-text)',
                margin: 0,
              }}
            >
              {id}
            </p>
          </div>
        )}

        {date && (
          <div
            style={{
              backgroundColor: 'var(--color-bg)',
              borderRadius: 'var(--radius-card)',
              padding: '1rem 1.25rem',
              marginBottom: '1rem',
              textAlign: 'left',
            }}
          >
            <p
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'var(--color-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                margin: '0 0 0.25rem',
              }}
            >
              Appointment Date
            </p>
            <p
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: '1.05rem',
                fontWeight: 600,
                color: 'var(--color-text)',
                margin: 0,
              }}
            >
              {formatAppointmentDate(date)}
            </p>
            {ws && we && (
              <p
                style={{
                  color: 'var(--color-text-muted)',
                  margin: '0.25rem 0 0',
                  fontSize: '0.95rem',
                }}
              >
                {formatWindow(ws, we)}
              </p>
            )}
          </div>
        )}

        <div
          style={{
            backgroundColor: 'var(--color-bg)',
            borderRadius: 'var(--radius-card)',
            padding: '1rem 1.25rem',
            marginBottom: '2rem',
            textAlign: 'left',
          }}
        >
          <p
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              margin: '0 0 0.25rem',
            }}
          >
            Questions? Call Us
          </p>
          <a
            href={`tel:${OFFICE_PHONE_DIGITS}`}
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: '1.1rem',
              fontWeight: 700,
              color: 'var(--color-primary)',
              textDecoration: 'none',
            }}
          >
            {OFFICE_PHONE}
          </a>
        </div>

        <Link
          href={`/embed/scheduler${widgetKey ? `?key=${widgetKey}` : ''}`}
          style={{
            display: 'inline-block',
            backgroundColor: 'var(--color-primary)',
            color: '#fff',
            fontFamily: 'var(--font-heading)',
            fontWeight: 600,
            fontSize: '1rem',
            padding: '0.75rem 2rem',
            borderRadius: 'var(--radius-input)',
            textDecoration: 'none',
            minHeight: '44px',
            lineHeight: '1.5',
          }}
        >
          Book another appointment
        </Link>
      </div>
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--color-bg)',
          }}
        >
          <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
        </div>
      }
    >
      <ConfirmationContent />
    </Suspense>
  );
}
