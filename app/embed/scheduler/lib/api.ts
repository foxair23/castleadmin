import { BookingPayload, BookingResponse, DateAvailability, PartialLeadPayload, SchedulerConfig, SubmitResult } from './types';

export const DEFAULT_CONFIG: SchedulerConfig = {
  office_phone: '(800) 576-1397',
  time_windows: [
    { start: '08:00', end: '12:00', label: '8 AM – 12 PM' },
    { start: '12:00', end: '16:00', label: '12 PM – 4 PM' },
  ],
  scheduling_horizon_days: 14,
  available_days: [1, 2, 3, 4, 5, 6],
  incentive_banner_enabled: true,
  incentive_banner_text: '$50 off your first service',
  tcpa_copy:
    'By checking this box, you consent to receive text messages about your appointment from Castle Garage Doors & Gates. Message and data rates may apply. Reply STOP to opt out.',
  marketing_sms_copy: "I'd like to receive promotions and tips by SMS.",
  scheduling_enabled: true,
  scheduling_disabled_message:
    'Online scheduling is temporarily unavailable. Please call us to book.',
  service_call_fee: 99,
  gate_service_call_fee: 99,
};

export async function fetchAvailability(
  from: string,
  to: string,
  widgetKey: string
): Promise<Record<string, DateAvailability>> {
  try {
    const res = await fetch(`/api/scheduler/availability?from=${from}&to=${to}`, {
      headers: { 'X-Castle-Widget-Key': widgetKey },
    })
    if (!res.ok) return {}
    const data = await res.json() as { dates: Record<string, DateAvailability> }
    return data.dates ?? {}
  } catch {
    return {}
  }
}

export async function savePartialLead(payload: PartialLeadPayload): Promise<string | null> {
  try {
    const res = await fetch('/api/scheduler/partial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

export async function submitBooking(
  payload: BookingPayload,
  widgetKey: string
): Promise<SubmitResult> {
  const res = await fetch('/api/scheduler/bookings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Castle-Widget-Key': widgetKey,
    },
    body: JSON.stringify({ ...payload, widget_key: widgetKey }),
  });

  if (res.ok) {
    const data: BookingResponse = await res.json();
    return { ok: true, data };
  }

  let errorMessage = ''
  try {
    const body = await res.json()
    errorMessage = (body as { error?: string }).error ?? ''
  } catch { /* ignore */ }

  return { ok: false, status: res.status, error: errorMessage };
}
