const FROM = 'Castle Garage Doors <noreply@updates.castlegaragedoors.com>'

export async function sendEmail(params: {
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
  bcc?: string | string[]
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
      ...(params.bcc ? { bcc: params.bcc } : {}),
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Resend API ${res.status}: ${body}`)
  }
}
