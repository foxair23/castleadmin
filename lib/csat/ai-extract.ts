// AI fallback for CSAT score corrections.
//
// parseRating (parse.ts) only accepts a message with exactly one 1–5 digit. A
// natural-language correction like "oops that 1 should've been a 5" or "I meant
// 5 not 1" has two numbers, so the deterministic parser rejects it. When a
// customer already has a recorded rating and sends such a reply, we hand it to
// Claude to decide whether it expresses a NEW intended 1–5 score.
//
// Dormant unless ANTHROPIC_API_KEY is set: no key → no call → regex-only behavior.
// Deliberately conservative: only a HIGH-confidence, unambiguous new rating is
// returned; anything else is null (the caller then treats the text as feedback).

export function isCsatAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

// Short structured read — Haiku is the right tier. Reuses the LeadGen override
// if set; CSAT_AI_MODEL wins if you ever want them to differ.
const MODEL = process.env.CSAT_AI_MODEL || process.env.LEADGEN_AI_MODEL || 'claude-haiku-4-5'

const CORRECTION_TOOL = {
  name: 'record_correction',
  description: 'Record whether the customer is correcting/changing their satisfaction rating, and to what.',
  input_schema: {
    type: 'object',
    properties: {
      is_correction: { type: 'boolean', description: 'True ONLY if the message clearly states the customer meant a DIFFERENT 1–5 satisfaction rating than before (e.g. "I meant 5 not 1", "oops that should be a 4"). False for general feedback, complaints, questions, or anything ambiguous.' },
      corrected_rating: { type: 'integer', description: 'The new intended rating, 1–5. Use 0 if not clearly stated.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How certain you are that this is an intentional correction to the given rating value.' },
    },
    required: ['is_correction', 'corrected_rating', 'confidence'],
  },
} as const

export interface CsatCorrection {
  correctedRating: number
  confidence: 'high' | 'medium' | 'low'
}

/**
 * Ask Claude whether an inbound reply corrects the customer's rating. Returns
 * the new rating only when the model is HIGH-confidence it's an intentional
 * 1–5 correction; null otherwise (including any error, no key, or ambiguity).
 */
export async function aiExtractCsatCorrection(text: string, priorRating: number | null): Promise<CsatCorrection | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        tools: [CORRECTION_TOOL],
        tool_choice: { type: 'tool', name: 'record_correction' },
        messages: [{
          role: 'user',
          content: `A customer was texted "How satisfied were you? Reply 1–5 (5 = very satisfied)."${priorRating != null ? ` They previously replied with a rating of ${priorRating}.` : ''} This new reply may be changing/correcting their rating. Decide if it clearly states a new intended 1–5 rating. Do not guess.\n\nREPLY:\n${text.slice(0, 500)}`,
        }],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { content?: Array<{ type: string; input?: Record<string, unknown> }> }
    const out = (data.content ?? []).find(b => b.type === 'tool_use')?.input
    if (!out || out.is_correction !== true) return null
    const rating = Number(out.corrected_rating)
    const confidence = out.confidence
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null
    if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') return null
    return { correctedRating: rating, confidence }
  } catch {
    return null
  }
}
