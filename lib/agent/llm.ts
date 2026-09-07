import Anthropic from '@anthropic-ai/sdk'

// One Anthropic client for every agent call. Dormant without ANTHROPIC_API_KEY —
// callers check isLlmConfigured() and degrade (draft-for-review with a note) rather
// than throw. Model ids come from agent_settings so they can change without a deploy.

let _client: Anthropic | null = null

export function isLlmConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

export function llm(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 })
  return _client
}

/** Haiku 4.5 still takes budget_tokens; the 5-family uses adaptive thinking. */
export function isAdaptiveThinkingModel(model: string): boolean {
  return !/haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|3-\d/.test(model)
}

/** Human-readable failure for the review queue / logs. Never leaks the key. */
export function describeLlmError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Anthropic API key rejected'
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic rate limit — will retry on the next pass'
  if (e instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${e.message}`
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}
