'use client';

import { useState, useRef, useEffect } from 'react';
import { DateAvailability, FlowState, SchedulerConfig, WindowAvailability } from '../../lib/types';
import { fetchAvailability } from '../../lib/api';

interface Props {
  state: FlowState;
  config: SchedulerConfig;
  widgetKey: string;
  onNext: (partial: Partial<FlowState>) => void;
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildCandidateDates(horizon: number, availableDays: number[]): Date[] {
  const dates: Date[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 1; i <= horizon; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    if (availableDays.includes(d.getDay())) dates.push(d);
  }
  return dates;
}

export default function StepSchedule({ state, config, widgetKey, onNext }: Props) {
  const [selectedDate, setSelectedDate] = useState<string | null>(state.appointment_date);
  const [selectedWindow, setSelectedWindow] = useState<WindowAvailability | null>(() => {
    if (!state.appointment_window_start) return null;
    const w = config.time_windows.find(
      (w) => w.start === state.appointment_window_start && w.end === state.appointment_window_end
    );
    return w ? { ...w, available: true } : null;
  });
  const [errors, setErrors] = useState<{ date?: string; window?: string }>({});
  const [availability, setAvailability] = useState<Record<string, DateAvailability>>({});
  const [loadingAvailability, setLoadingAvailability] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const candidateDates = buildCandidateDates(config.scheduling_horizon_days, config.available_days);

  // Fetch availability for the full horizon on mount
  useEffect(() => {
    if (candidateDates.length === 0) { setLoadingAvailability(false); return; }
    const from = toYMD(candidateDates[0]);
    const to = toYMD(candidateDates[candidateDates.length - 1]);
    setLoadingAvailability(true);
    fetchAvailability(from, to, widgetKey).then((data) => {
      setAvailability(data);
      setLoadingAvailability(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Available dates = candidate dates that have at least one open window
  const availableDates = candidateDates.filter((d) => {
    const ymd = toYMD(d);
    const avail = availability[ymd];
    // While loading, show all candidate dates (skeleton); after load, filter
    return loadingAvailability || !avail || avail.available;
  });

  // Windows shown for the selected date
  const windowsForDate: WindowAvailability[] = selectedDate
    ? (availability[selectedDate]?.windows ?? config.time_windows.map((w) => ({ ...w, available: true })))
    : config.time_windows.map((w) => ({ ...w, available: true }));

  useEffect(() => {
    if (scrollRef.current && selectedDate) {
      const btn = scrollRef.current.querySelector(`[data-date="${selectedDate}"]`);
      if (btn) {
        (btn as HTMLElement).scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }, [selectedDate]);

  // If selected window becomes unavailable after load, clear it
  useEffect(() => {
    if (!selectedWindow || !selectedDate || loadingAvailability) return;
    const windows = availability[selectedDate]?.windows;
    if (!windows) return;
    const match = windows.find((w) => w.start === selectedWindow.start && w.end === selectedWindow.end);
    if (match && !match.available) setSelectedWindow(null);
  }, [availability, selectedDate, selectedWindow, loadingAvailability]);

  function handleSelectDate(ymd: string) {
    setSelectedDate(ymd);
    setErrors((e) => ({ ...e, date: undefined }));
    // Clear window if it's not available on the new date
    if (selectedWindow) {
      const avail = availability[ymd];
      if (avail) {
        const match = avail.windows.find(
          (w) => w.start === selectedWindow.start && w.end === selectedWindow.end
        );
        if (match && !match.available) setSelectedWindow(null);
      }
    }
  }

  function handleNext() {
    const errs: typeof errors = {};
    if (!selectedDate) errs.date = 'Please select a date.';
    if (!selectedWindow) errs.window = 'Please select a time window.';
    if (errs.date || errs.window) { setErrors(errs); return; }
    onNext({
      appointment_date: selectedDate!,
      appointment_window_start: selectedWindow!.start,
      appointment_window_end: selectedWindow!.end,
    });
  }

  // Too-soon windows are hidden entirely; full/unavailable windows stay visible (greyed)
  const visibleWindows = windowsForDate.filter((w) => w.reason !== 'too_soon');

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
        Request a Time
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '0.875rem', fontSize: '0.95rem' }}>
        Pick your <strong style={{ color: 'var(--color-primary)', fontWeight: 700 }}>preferred</strong>{' '}date and time window — we&apos;ll call you to confirm the appointment.
      </p>

      {state.service_type && (() => {
        const FREE_ESTIMATE_TYPES = ['door_panel_replacement', 'new_gate_replacement']
        const isFreeEstimate = FREE_ESTIMATE_TYPES.includes(state.service_type)
        const fee = state.primary_category === 'gate'
          ? (config.gate_service_call_fee ?? config.service_call_fee ?? 99)
          : (config.service_call_fee ?? 99)
        return (
          <div
            style={{
              backgroundColor: '#F0FDF4',
              border: '1.5px solid #86EFAC',
              borderRadius: 'var(--radius-card)',
              padding: '0.625rem 0.875rem',
              marginBottom: '1.25rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.625rem',
            }}
          >
            <div>
              <p style={{ margin: 0, fontWeight: 600, fontSize: '0.875rem', color: '#15803D' }}>
                {isFreeEstimate ? 'Free Estimate' : `$${fee} Service Call Fee`}
              </p>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#166534', marginTop: '0.125rem' }}>
                {isFreeEstimate
                  ? 'No service call fee — this visit is a free estimate.'
                  : `Covers the technician visit, inspection, diagnosis, and simple adjustments. If repairs require parts or additional labor, we'll provide upfront pricing before any work begins.`}
              </p>
            </div>
          </div>
        )
      })()}

      <p
        style={{
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: '0.9rem',
          color: 'var(--color-text)',
          marginBottom: '0.625rem',
        }}
      >
        Select a date
      </p>
      <div
        ref={scrollRef}
        role="group"
        aria-label="Available appointment dates"
        style={{
          display: 'flex',
          gap: '0.625rem',
          overflowX: 'auto',
          paddingBottom: '0.5rem',
          marginBottom: errors.date ? '0.25rem' : '1.5rem',
          scrollbarWidth: 'thin',
        }}
      >
        {loadingAvailability
          ? candidateDates.slice(0, 7).map((date) => (
              <div
                key={toYMD(date)}
                style={{
                  flexShrink: 0,
                  width: '64px',
                  minHeight: '72px',
                  backgroundColor: 'var(--color-border)',
                  borderRadius: 'var(--radius-card)',
                  opacity: 0.5,
                }}
              />
            ))
          : availableDates.map((date) => {
              const ymd = toYMD(date);
              const isSelected = selectedDate === ymd;
              return (
                <button
                  key={ymd}
                  type="button"
                  data-date={ymd}
                  aria-pressed={isSelected}
                  onClick={() => handleSelectDate(ymd)}
                  style={{
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '64px',
                    minHeight: '72px',
                    padding: '0.5rem 0.375rem',
                    backgroundColor: isSelected ? 'var(--color-primary)' : 'var(--color-white)',
                    color: isSelected ? '#fff' : 'var(--color-text)',
                    border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    borderRadius: 'var(--radius-card)',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s, border-color 0.15s, color 0.15s',
                  }}
                >
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {DAY_ABBR[date.getDay()]}
                  </span>
                  <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '1.25rem', lineHeight: 1.1, margin: '2px 0' }}>
                    {date.getDate()}
                  </span>
                  <span style={{ fontSize: '0.7rem', opacity: 0.8 }}>
                    {MONTH_ABBR[date.getMonth()]}
                  </span>
                </button>
              );
            })
        }
        {!loadingAvailability && availableDates.length === 0 && (
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
            No available dates found. Please call us to schedule.
          </p>
        )}
      </div>
      {errors.date && (
        <p role="alert" style={{ color: 'var(--color-primary)', fontSize: '0.8rem', marginTop: '-1rem', marginBottom: '1rem' }}>
          {errors.date}
        </p>
      )}

      <p
        style={{
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: '0.9rem',
          color: 'var(--color-text)',
          marginBottom: '0.625rem',
        }}
      >
        Select a time window
      </p>
      <div
        role="group"
        aria-label="Available time windows"
        style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', marginBottom: errors.window ? '0.25rem' : '0.625rem' }}
      >
        {visibleWindows.map((window) => {
          const isSelected =
            selectedWindow?.start === window.start && selectedWindow?.end === window.end;
          const unavailable = !window.available;
          return (
            <button
              key={`${window.start}-${window.end}`}
              type="button"
              aria-pressed={isSelected}
              disabled={unavailable}
              onClick={() => {
                if (unavailable) return;
                setSelectedWindow(window);
                setErrors((e) => ({ ...e, window: undefined }));
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                padding: '0.875rem 1.25rem',
                backgroundColor: unavailable
                  ? 'var(--color-border)'
                  : isSelected
                  ? '#FEF2F2'
                  : 'var(--color-white)',
                color: unavailable
                  ? 'var(--color-text-muted)'
                  : isSelected
                  ? 'var(--color-primary)'
                  : 'var(--color-text)',
                border: `2px solid ${
                  unavailable ? 'transparent' : isSelected ? 'var(--color-primary)' : 'var(--color-border)'
                }`,
                borderRadius: 'var(--radius-card)',
                cursor: unavailable ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-heading)',
                fontWeight: 600,
                fontSize: '1rem',
                minHeight: '44px',
                opacity: unavailable ? 0.6 : 1,
                transition: 'background-color 0.15s, border-color 0.15s, color 0.15s',
              }}
            >
              {window.label}
              {unavailable && (
                <span style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.8 }}>(Full)</span>
              )}
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)', marginBottom: '1.5rem', lineHeight: 1.4 }}>
        Need service sooner? Give us a call to see if we can accommodate —{' '}
        <a href={`tel:${config.office_phone.replace(/\D/g, '')}`} style={{ color: 'var(--color-primary)', fontWeight: 600, textDecoration: 'none' }}>
          {config.office_phone}
        </a>
      </p>
      {errors.window && (
        <p role="alert" style={{ color: 'var(--color-primary)', fontSize: '0.8rem', marginTop: '-1rem', marginBottom: '1rem' }}>
          {errors.window}
        </p>
      )}

      <button
        type="button"
        onClick={handleNext}
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
        Continue
      </button>
    </div>
  );
}
