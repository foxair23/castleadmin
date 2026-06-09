/**
 * Scheduler analytics — sends events to the parent page via postMessage.
 *
 * The parent page must add a listener to relay events to GA4:
 *
 *   window.addEventListener('message', function(e) {
 *     if (e.data && e.data.type === 'castle-scheduler-event') {
 *       gtag('event', e.data.event, e.data.params || {});
 *     }
 *   });
 *
 * GA4 measurement ID: G-MGQ68MY9W3
 * Make sure the gtag snippet with that ID is loaded on the parent page.
 */

const STEP_NAMES: Record<number, string> = {
  1: 'zip_code',
  2: 'contact_info',
  3: 'service_category',
  4: 'service_type',
  5: 'question_1',
  6: 'question_2',
  7: 'question_3',
  8: 'optional_details',
  9: 'schedule',
  10: 'property_details',
  11: 'review',
};

function sendToParent(event: string, params: Record<string, unknown> = {}) {
  if (typeof window === 'undefined') return;
  try {
    window.parent.postMessage({ type: 'castle-scheduler-event', event, params }, '*');
  } catch {
    // cross-origin postMessage can throw in some environments — silently ignore
  }
}

export function trackStep(stepNumber: number) {
  sendToParent('scheduler_step', {
    step_number: stepNumber,
    step_name: STEP_NAMES[stepNumber] ?? `step_${stepNumber}`,
  });
}

export function trackBookingConfirmed(params: {
  booking_id: string | null;
  date: string | null;
}) {
  sendToParent('booking_confirmed', {
    booking_id: params.booking_id ?? undefined,
    appointment_date: params.date ?? undefined,
  });
}
