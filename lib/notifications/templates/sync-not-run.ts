const BASE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #111827;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`
const HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 16px; color: #b91c1c;`
const BODY = `font-size: 15px; line-height: 1.6; margin: 0 0 16px;`
const MUTED = `font-size: 13px; color: #6b7280; margin: 24px 0 0;`

export interface SyncNotRunData {
  hoursSinceLastSync: number
  lastRunAt: string | null  // human-readable, e.g. "Tuesday, June 10 at 8:05 AM"
  adminUrl: string
}

export function renderSyncNotRun(data: SyncNotRunData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const subject = `Alert: Service Fusion sync has not run in ${data.hoursSinceLastSync}+ hours`

  const lastRunText = data.lastRunAt
    ? `Last successful sync: ${data.lastRunAt}`
    : `No successful sync found.`

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">SF Sync Overdue</p>
  <p style="${BODY}">
    The Service Fusion data sync has not completed successfully in over
    <strong>${data.hoursSinceLastSync} hours</strong>.
  </p>
  <p style="${BODY}">${lastRunText}</p>
  <p style="${BODY}">
    Castle Admin data (jobs, invoices, estimates) may be out of date.
    Check the Integrations page for details and trigger a manual sync if needed.
  </p>
  <p style="${MUTED}">
    <a href="${data.adminUrl}" style="color: #dc2626;">Go to Integrations →</a>
  </p>
</div>`.trim()

  const bodyText = [
    `SF Sync Overdue`,
    ``,
    `The Service Fusion sync has not run in over ${data.hoursSinceLastSync} hours.`,
    `${lastRunText}`,
    ``,
    `Castle Admin data may be out of date. Check the Integrations page.`,
  ].join('\n')

  return { subject, bodyHtml, bodyText }
}
