const BASE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #111827;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`
const HEADING = `font-size: 20px; font-weight: 700; margin: 0 0 16px;`
const BODY = `font-size: 15px; line-height: 1.6; margin: 0 0 16px;`
const MUTED = `font-size: 13px; color: #6b7280; margin: 24px 0 0;`

export interface PieceworkReminderData {
  fullName: string
  weekLabel: string     // e.g. "June 2 – 8"
  deadlineDate: string  // e.g. "Wednesday, June 11 at 11:59 PM"
  submitUrl: string
}

export function renderPieceworkReminder(data: PieceworkReminderData): {
  subject: string
  bodyHtml: string
  bodyText: string
} {
  const subject = `Reminder: Submit your piecework for ${data.weekLabel}`

  const bodyHtml = `
<div style="${BASE}">
  <p style="${HEADING}">Piecework Submission Reminder</p>
  <p style="${BODY}">Hi ${data.fullName},</p>
  <p style="${BODY}">
    This is a reminder to submit your piecework for the week of
    <strong>${data.weekLabel}</strong>.
  </p>
  <p style="${BODY}">
    <strong>Deadline: ${data.deadlineDate}</strong>
  </p>
  <p style="${BODY}">
    Log in to Castle Admin and submit your jobs before the deadline.
    After the deadline your week will be locked and cannot be updated.
  </p>
  <p style="${MUTED}">
    You're receiving this because you have not yet submitted piecework for this week.
    Reply to your supervisor if you have questions.
  </p>
</div>`.trim()

  const bodyText = [
    `Piecework Submission Reminder`,
    ``,
    `Hi ${data.fullName},`,
    ``,
    `This is a reminder to submit your piecework for the week of ${data.weekLabel}.`,
    ``,
    `Deadline: ${data.deadlineDate}`,
    ``,
    `Log in to Castle Admin and submit your jobs before the deadline.`,
  ].join('\n')

  return { subject, bodyHtml, bodyText }
}
