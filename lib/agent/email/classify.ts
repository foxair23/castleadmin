import type Anthropic from '@anthropic-ai/sdk'
import { llm, isLlmConfigured } from '@/lib/agent/llm'
import type { QuestionType } from '@/lib/agent/settings'

// Stage 3a — what is actually being asked (PRD §5). A short structured read, so the
// classifier model (Haiku by default) with a forced tool call. The regex extraction in
// identifiers.ts stays authoritative for PO numbers; the model may ADD a customer
// name it reads from prose and a PO the regex missed, never remove one.

export const QUESTION_TYPES: QuestionType[] = ['schedule', 'completion', 'tech', 'status', 'material', 'ship_date', 'pricing', 'warranty', 'reschedule', 'complaint', 'multi', 'other']

export interface Classification {
  questionType: QuestionType
  /** One line, in the partner's terms: "When is PO 1020259181 scheduled for install?" */
  summary: string
  customerName: string | null
  extraPos: string[]
  /** More than one distinct question → never auto-sent (PRD §6.3). */
  isMultiPart: boolean
  /** The email TELLS us something and asks nothing — "staged for pickup on 9/23". */
  isNotification: boolean
  /** The sender asked whether they are talking to a bot / wants a human. */
  asksForHuman: boolean
  model: string
}

const TOOL: Anthropic.Tool = {
  name: 'classify_inquiry',
  description: 'Record what a trade-partner email to a garage door installer is asking.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['question_type', 'summary', 'customer_name', 'extra_pos', 'is_multi_part', 'asks_for_human', 'is_notification'],
    properties: {
      question_type: {
        type: 'string', enum: QUESTION_TYPES,
        description: [
          'status = asking where something stands, INCLUDING when it is scheduled: "do you have an install date for this customer?", "what is the delivery date for PO 88984640?", "can I get an update on PO 69427561?", "when will the site check be scheduled?". Anything answerable by reading the job.',
          'schedule = asking US to take a scheduling ACTION, not asking for a date we already hold: "please contact the customer to schedule delivery", "customer has not been contacted, please reach out". Someone at Castle has to do something; no date exists to report yet.',
          'completion = has the work been done; tech = which technician; material = parts/doors/sections received, damaged, missing; ship_date = when will the manufacturer ship; pricing = invoice, payment, cost; warranty; reschedule = a request to CHANGE an appointment that already exists; complaint; multi = several distinct questions; other.',
        ].join(' '),
      },
      summary: { type: 'string', description: 'The question in one sentence, keeping any PO / order numbers verbatim.' },
      customer_name: { type: ['string', 'null'], description: 'The homeowner / end customer named in the email, as written. null if none.' },
      extra_pos: { type: 'array', items: { type: 'string' }, description: 'PO, order, or job numbers mentioned in the email (digits only). Empty if none.' },
      is_multi_part: { type: 'boolean', description: 'True if the sender asks more than one distinct question.' },
      asks_for_human: { type: 'boolean', description: 'True if the sender asks to speak to a person / manager or asks whether they are talking to a bot.' },
      is_notification: { type: 'boolean', description: 'True when the email only TELLS us something and asks nothing of us — "Order 181195118 has been staged for pickup on 9/23", "the door has arrived and is available for pickup", a delivery or status announcement. False whenever it asks a question, requests an action, or needs any answer from us, even a short one.' },
    },
  },
}

export async function classifyInquiry(input: { subject: string; body: string; fromDomain: string; model: string }): Promise<Classification | null> {
  if (!isLlmConfigured()) return null
  const res = await llm().messages.create({
    model: input.model,
    max_tokens: 512,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'classify_inquiry' },
    system: 'You classify inbound emails to Castle Garage Doors & Gates from trade partners (Home Depot stores, Clopay, Genie). Read carefully; do not invent identifiers that are not in the text.',
    messages: [{ role: 'user', content: `From domain: ${input.fromDomain}\nSubject: ${input.subject}\n\n${input.body.slice(0, 6000)}` }],
  })
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
  if (!tu) return null
  const i = tu.input as { question_type: QuestionType; summary: string; customer_name: string | null; extra_pos: string[]; is_multi_part: boolean; asks_for_human: boolean; is_notification?: boolean }
  return {
    questionType: QUESTION_TYPES.includes(i.question_type) ? i.question_type : 'other',
    summary: (i.summary ?? '').trim().slice(0, 300),
    customerName: i.customer_name?.trim() || null,
    extraPos: (i.extra_pos ?? []).map(p => String(p).replace(/\D/g, '')).filter(p => p.length >= 6),
    isMultiPart: !!i.is_multi_part || i.question_type === 'multi',
    isNotification: !!i.is_notification,
    asksForHuman: !!i.asks_for_human,
    model: res.model,
  }
}
