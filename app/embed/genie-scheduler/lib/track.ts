// Genie funnel tracking — fire-and-forget POST to the track route. Never throws,
// never blocks the flow. One anonymous session id per visit.

export function newGenieSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch { /* fall through */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function trackGenieStep(
  widgetKey: string,
  sessionId: string,
  step: string,
  detail?: Record<string, unknown>,
  orderNumber?: string | null,
): void {
  try {
    const body = JSON.stringify({ session_id: sessionId, step, detail: detail ?? {}, order_number: orderNumber ?? null })
    // keepalive lets the 'booked' event survive the page navigation to the
    // confirmation screen.
    void fetch('/api/genie-scheduler/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Castle-Widget-Key': widgetKey },
      body,
      keepalive: true,
    }).catch(() => {})
  } catch { /* best-effort */ }
}
