import { SchedulerConfig, BookingPayload, BookingResponse } from './types';

export const DEFAULT_CONFIG: SchedulerConfig = {
  office_phone: '(800) 576-1397',
  time_windows: [
    { start: '08:00', end: '12:00', label: '8 AM – 12 PM' },
    { start: '12:00', end: '16:00', label: '12 PM – 4 PM' },
  ],
  scheduling_horizon_days: 14,
  available_days: [1, 2, 3, 4, 5, 6],
  garage_door_categories: ['Repair & Service', 'New Installation', 'Maintenance'],
  gate_categories: ['Repair & Service', 'New Installation', 'Maintenance'],
  garage_door_issues: [
    "Won't open or close",
    'Making noise',
    'Moving slowly',
    'Off the tracks',
    'Broken spring',
    'Opener not working',
    'Damaged panel',
    'Remote / keypad issue',
    'Safety sensor issue',
    'Weather seal damaged',
  ],
  gate_issues: [
    "Won't open or close",
    'Making noise',
    'Moving slowly',
    'Off track',
    'Motor / opener issue',
    'Remote / keypad issue',
    'Damaged gate',
    'Safety sensor issue',
  ],
  incentive_banner_enabled: true,
  incentive_banner_text: '$50 off your first service',
  tcpa_copy:
    'By checking this box, you consent to receive text messages about your appointment from Castle Garage Doors & Gates. Message and data rates may apply. Reply STOP to opt out.',
  marketing_sms_copy: "I'd like to receive promotions and tips by SMS.",
  scheduling_enabled: true,
  scheduling_disabled_message:
    'Online scheduling is temporarily unavailable. Please call us to book.',
};

export async function fetchConfig(widgetKey: string): Promise<SchedulerConfig> {
  try {
    const res = await fetch('/api/scheduler/config', {
      headers: {
        'X-Castle-Widget-Key': widgetKey,
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      return DEFAULT_CONFIG;
    }
    const data = await res.json();
    return { ...DEFAULT_CONFIG, ...data };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function submitBooking(
  payload: BookingPayload,
  widgetKey: string
): Promise<{ ok: true; data: BookingResponse } | { ok: false; status: number }> {
  const res = await fetch('/api/scheduler/bookings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Castle-Widget-Key': widgetKey,
    },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    const data: BookingResponse = await res.json();
    return { ok: true, data };
  }

  return { ok: false, status: res.status };
}
