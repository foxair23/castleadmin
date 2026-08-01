// AI fallback parser for inbound lead emails.
//
// The deterministic parser (parse.ts) handles known providers (Home Depot) for
// free and instantly. When it can't — an unknown provider, or a layout it
// doesn't recognize — we hand the email body to Claude and ask it to extract the
// same fields into a fixed shape. New providers then work with no new parser code.
//
// Dormant unless ANTHROPIC_API_KEY is set: no key → no call → regex-only behavior.

import { toE164 } from '@/lib/dialpad/client'
import type { ParsedLead } from './parse'

export function isAiExtractConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

// Extraction is a simple structured read of a short email — Haiku is the right
// tier (fast + cheap). Override with LEADGEN_AI_MODEL if ever needed.
const MODEL = process.env.LEADGEN_AI_MODEL || 'claude-haiku-4-5'

const EXTRACT_TOOL = {
  name: 'record_lead',
  description: 'Record the customer lead details extracted from the email.',
  input_schema: {
    type: 'object',
    properties: {
      is_lead: { type: 'boolean', description: 'True if this email is a customer service/repair lead from a referral provider (Home Depot, Angi, Thumbtack, etc.). False for newsletters, receipts, or anything that is not a new customer lead.' },
      provider: { type: 'string', description: "The referral source/company that sent the lead, e.g. 'Home Depot', 'Angi'. Empty string if unclear." },
      customer_name: { type: 'string', description: 'Full name of the customer. Empty string if not present.' },
      phone: { type: 'string', description: 'Customer phone number, digits as written. Empty string if not present.' },
      email: { type: 'string', description: 'Customer email address. Empty string if not present.' },
      address_street: { type: 'string', description: 'Street address. Empty string if not present.' },
      address_city: { type: 'string', description: 'City. Empty string if not present.' },
      address_state: { type: 'string', description: 'Two-letter state. Empty string if not present.' },
      address_postal: { type: 'string', description: 'ZIP code. Empty string if not present.' },
      service_description: { type: 'string', description: 'What the customer needs / the reported issue. Empty string if not present.' },
      notes: { type: 'string', description: 'Any other relevant notes. Empty string if none.' },
    },
    required: ['is_lead'],
  },
} as const

const clean = (s: unknown): string | null => {
  const v = typeof s === 'string' ? s.trim() : ''
  return v || null
}

function slugProvider(name: string | null): string {
  if (!name) return 'unknown'
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return s || 'unknown'
}

/** Extract a lead from an email body with Claude. Returns null on any failure,
 *  when the model says it isn't a lead, or when there's no way to reach them. */
export async function aiExtractLead(text: string): Promise<ParsedLead | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'record_lead' },
        messages: [{
          role: 'user',
          content: `Extract the customer lead details from this forwarded email. It may be from any home-services referral provider. Use empty strings for anything not present; do not guess.\n\nEMAIL:\n${text.slice(0, 12000)}`,
        }],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { content?: Array<{ type: string; input?: Record<string, unknown> }> }
    const block = (data.content ?? []).find(b => b.type === 'tool_use')
    const out = block?.input
    if (!out || out.is_lead !== true) return null

    const customerName = clean(out.customer_name)
    const phoneRaw = clean(out.phone)
    const email = clean(out.email)?.toLowerCase() ?? null
    // Need a name and at least one way to reach them, or it's not actionable.
    if (!customerName && !phoneRaw && !email) return null
    // Sanity-check contact fields so a misread can't produce a bogus recipient.
    const validEmail = email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null
    const validPhone = phoneRaw && toE164(phoneRaw) ? phoneRaw : null
    if (!validEmail && !validPhone) return null

    return {
      provider: slugProvider(clean(out.provider)),
      externalId: null,
      customerName,
      phoneRaw: validPhone,
      email: validEmail,
      addressStreet: clean(out.address_street),
      addressCity: clean(out.address_city),
      addressState: clean(out.address_state),
      addressPostal: clean(out.address_postal),
      programName: clean(out.service_description),
      source: clean(out.provider),
      referralStore: null,
      notes: clean(out.notes),
    }
  } catch {
    return null
  }
}
