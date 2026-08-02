// Low CSAT alert — emailed to subscribed admins (and any configured extra
// recipients) the moment a customer rates a completed job 1–3. Mirrors the
// scheduler-lead-stuck template shape.

const BASE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #111827;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`
const HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 16px; color: #b91c1c;`
const LABEL = `font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;`
const VALUE = `font-size: 15px; margin: 2px 0 12px;`
const MUTED = `font-size: 13px; color: #6b7280; margin: 24px 0 0;`

export interface LowCsatAlertData {
  customerName: string
  score: number
  jobNumber: string | null
  employeeName: string | null
  jobType: string | null
  completedAt: string | null
  customerPhone: string | null
  feedback?: string | null
  caseUrl: string
}

export function renderLowCsatAlert(data: LowCsatAlertData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const subject = `Low CSAT Alert — ${data.customerName} rated ${data.score}/5`

  const row = (label: string, value: string | null | undefined, color?: string) =>
    value ? `<p style="${LABEL}">${label}</p><p style="${VALUE}${color ? `; color:${color}` : ''}">${value}</p>` : ''

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">Low CSAT Alert</p>
  ${row('Customer', data.customerName)}
  ${row('Score', `${data.score}/5`, '#dc2626')}
  ${row('Job', data.jobNumber)}
  ${row('Technician / Installer', data.employeeName)}
  ${row('Job Type', data.jobType)}
  ${row('Completed', data.completedAt)}
  ${row('Customer Phone', data.customerPhone)}
  ${row('Feedback', data.feedback)}
  <p style="${MUTED}">
    <a href="${data.caseUrl}" style="color: #dc2626;">Open in Castle Admin → Reviews → CSAT →</a>
  </p>
</div>`.trim()

  const lines = [
    'Low CSAT Alert',
    '',
    `Customer: ${data.customerName}`,
    `Score: ${data.score}/5`,
    ...(data.jobNumber ? [`Job: ${data.jobNumber}`] : []),
    ...(data.employeeName ? [`Technician/Installer: ${data.employeeName}`] : []),
    ...(data.jobType ? [`Job Type: ${data.jobType}`] : []),
    ...(data.completedAt ? [`Completed: ${data.completedAt}`] : []),
    ...(data.customerPhone ? [`Customer Phone: ${data.customerPhone}`] : []),
    ...(data.feedback ? [`Feedback: ${data.feedback}`] : []),
    '',
    `Open in Castle Admin: ${data.caseUrl}`,
  ]

  return { subject, bodyHtml, bodyText: lines.join('\n') }
}
