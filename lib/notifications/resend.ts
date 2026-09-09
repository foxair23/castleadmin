import { emailFrom } from '@/lib/config/domains'

// Env-driven (EMAIL_FROM). Keep on the OLD verified domain until Resend shows the new one
// Verified — an unverified sender fails every outbound email.
const FROM = emailFrom()

export async function sendEmail(params: {
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
  cc?: string | string[]
  bcc?: string | string[]
  /** File attachments — content is the raw bytes, base64-encoded on the wire. */
  attachments?: Array<{ filename: string; content: Uint8Array }>
}): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      ...(params.replyTo ? { reply_to: params.replyTo } : {}),
      ...(params.cc ? { cc: params.cc } : {}),
      ...(params.bcc ? { bcc: params.bcc } : {}),
      ...(params.attachments?.length ? { attachments: params.attachments.map(a => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) } : {}),
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Resend API ${res.status}: ${body}`)
  }
}
