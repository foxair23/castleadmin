'use client';

import { useState, useRef, useEffect } from 'react';
import { FlowState, SchedulerConfig, TimeWindow } from '../../lib/types';

interface Props {
  state: FlowState;
  config: SchedulerConfig;
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

function buildAvailableDates(horizon: number, availableDays: number[]): Date[] {
  const dates: Date[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 1; i <= horizon; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dow = d.getDay();
    if (availableDays.includes(dow)) {
      dates.push(d);
    }
  }
  return dates;
}

export default function StepSchedule({ state, config, onNext }: Props) {
  const [selectedDate, setSelectedDate] = useState<string | null>(state.appointment_date);
  const [selectedWindow, setSelectedWindow] = useState<TimeWindow | null>(() => {
    if (!state.appointment_window_start) return null;
    return (
      config.time_windows.find(
        (w) => w.start === state.appointment_window_start && w.end === state.appointment_window_end
      ) || null
    );
  });
  const [errors, setErrors] = useState<{ date?: string; window?: string }>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const availableDates = buildAvailableDates(
    config.scheduling_horizon_days,
    config.available_days
  );

  useEffect(() => {
    if (scrollRef.current && selectedDate) {
      const btn = scrollRef.current.querySelector(`[data-date="${selectedDate}"]`);
      if (btn) {
        (btn as HTMLElement).scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }, [selectedDate]);

  function handleNext() {
    const errs: typeof errors = {};
    if (!selectedDate) errs.date = 'Please select a date.';
    if (!selectedWindow) errs.window = 'Please select a time window.';
    if (errs.date || errs.window) {
      setErrors(errs);
      return;
    }
    onNext({
      appointment_date: selectedDate!,
      appointment_window_start: selectedWindow!.start,
      appointment_window_end: selectedWindow!.end,
    });
  }

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
        When works for you?
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.25rem', fontSize: '0.95rem' }}>
        Choose a date and time window for your appointment.
      </p>

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
        {availableDates.map((date) => {
          const ymd = toYMD(date);
          const isSelected = selectedDate === ymd;
          return (
            <button
              key={ymd}
              type="button"
              data-date={ymd}
              aria-pressed={isSelected}
              onClick={() => {
                setSelectedDate(ymd);
                setErrors((e) => ({ ...e, date: undefined }));
              }}
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
        })}
        {availableDates.length === 0 && (
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
        style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', marginBottom: errors.window ? '0.25rem' : '1.5rem' }}
      >
        {config.time_windows.map((window) => {
          const isSelected =
            selectedWindow?.start === window.start && selectedWindow?.end === window.end;
          return (
            <button
              key={`${window.start}-${window.end}`}
              type="button"
              aria-pressed={isSelected}
              onClick={() => {
                setSelectedWindow(window);
                setErrors((e) => ({ ...e, window: undefined }));
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0.875rem 1.25rem',
                backgroundColor: isSelected ? '#FEF2F2' : 'var(--color-white)',
                color: isSelected ? 'var(--color-primary)' : 'var(--color-text)',
                border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-card)',
                cursor: 'pointer',
                fontFamily: 'var(--font-heading)',
                fontWeight: 600,
                fontSize: '1rem',
                minHeight: '44px',
                transition: 'background-color 0.15s, border-color 0.15s, color 0.15s',
              }}
            >
              {window.label}
            </button>
          );
        })}
      </div>
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
