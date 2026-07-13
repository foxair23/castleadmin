/**
 * Commission eligibility rules (TRD §3.3) — pure, testable decision logic.
 *
 * The DB orchestration lives in engine.ts; this file holds only the rules that
 * decide, given a job's agents and the agent→tech mapping, which technician (if
 * any) a job credits and whether it needs admin review.
 */

export type EligibilityStatus = 'eligible' | 'not_accepted' | 'needs_review'
export type ReviewReason = 'multiple_agents' | 'unmapped_agent' | 'multiple_tokens' | 'unmapped_token'

export interface AgentOnJob {
  agent_id: string | null
  agent_first_name: string | null
  agent_last_name: string | null
}

export interface AgentMapping {
  tech_user_id: string
  agent_id: string | null
  agent_first_name: string | null
  agent_last_name: string | null
}

export interface AgentResolver {
  /** Resolve a single agent to a tech user id, or null if unmapped. */
  resolve(agent: AgentOnJob): string | null
}

export interface Classification {
  status: EligibilityStatus
  review_reason: ReviewReason | null
  tech_user_id: string | null
}

function nameKey(first: string | null, last: string | null): string | null {
  if (!first || !last) return null
  return `${first.trim().toLowerCase()}|${last.trim().toLowerCase()}`
}

/**
 * Build a resolver from the agent→tech map. Match priority: agent_id when
 * present, else first_name + last_name (case-insensitive) (§3.2).
 */
export function buildResolver(mappings: AgentMapping[]): AgentResolver {
  const byId = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const m of mappings) {
    if (m.agent_id) {
      byId.set(m.agent_id, m.tech_user_id)
    } else {
      const k = nameKey(m.agent_first_name, m.agent_last_name)
      if (k) byName.set(k, m.tech_user_id)
    }
  }
  return {
    resolve(agent: AgentOnJob): string | null {
      if (agent.agent_id && byId.has(agent.agent_id)) return byId.get(agent.agent_id)!
      const k = nameKey(agent.agent_first_name, agent.agent_last_name)
      if (k && byName.has(k)) return byName.get(k)!
      return null
    },
  }
}

/**
 * Classify a job from its agents (§3.3):
 *   • zero agents      → null (not commission-eligible; caller creates no row)
 *   • more than one    → needs_review / multiple_agents (excluded until resolved)
 *   • exactly one:
 *       – mapped       → eligible, credits that tech
 *       – unmapped     → needs_review / unmapped_agent
 *
 * Returns null when the job carries no agents at all.
 */
export function classifyJob(agents: AgentOnJob[], resolver: AgentResolver): Classification | null {
  if (agents.length === 0) return null

  if (agents.length > 1) {
    return { status: 'needs_review', review_reason: 'multiple_agents', tech_user_id: null }
  }

  const tech = resolver.resolve(agents[0])
  if (tech) {
    return { status: 'eligible', review_reason: null, tech_user_id: tech }
  }
  return { status: 'needs_review', review_reason: 'unmapped_agent', tech_user_id: null }
}

// ── Note tokens ($kyle$-style tags in job notes) ─────────────────────────────

export interface TokenMapping {
  token: string
  tech_user_id: string
}

/** token (lowercased) → tech user id. */
export function buildTokenMap(mappings: TokenMapping[]): Map<string, string> {
  return new Map(mappings.map(m => [m.token.trim().toLowerCase(), m.tech_user_id]))
}

/**
 * Extract $token$ tags from job text fields. A token must START WITH A LETTER
 * (then letters/digits/_/-), between two $ signs, case-insensitive, deduped.
 * The letter-first rule keeps dollar figures from false-matching: in
 * "quote $500-$700" the substring "$500-$" would otherwise parse as token
 * "500-", sending an agent-attributed job to review as an unknown token.
 */
export function extractNoteTokens(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>()
  for (const t of texts) {
    if (!t) continue
    for (const m of t.matchAll(/\$([a-z][a-z0-9_-]{0,19})\$/gi)) found.add(m[1].toLowerCase())
  }
  return [...found]
}

/**
 * Classify a job with note tokens taking precedence over the Agent field:
 *   • one or more tokens present:
 *       – any token unknown            → needs_review / unmapped_token (typo-proof:
 *                                        surfaces instead of silently dropping)
 *       – tokens resolve to ≥2 techs   → needs_review / multiple_tokens
 *       – all resolve to one tech      → eligible, credits that tech
 *   • no tokens → fall back to agent classification (classifyJob), so existing
 *     agent-attributed jobs keep working unchanged.
 */
export function classifyJobWithTokens(
  tokens: string[],
  tokenMap: Map<string, string>,
  agents: AgentOnJob[],
  resolver: AgentResolver,
): Classification | null {
  if (tokens.length > 0) {
    if (tokens.some(t => !tokenMap.has(t))) {
      return { status: 'needs_review', review_reason: 'unmapped_token', tech_user_id: null }
    }
    const techIds = [...new Set(tokens.map(t => tokenMap.get(t)!))]
    if (techIds.length > 1) {
      return { status: 'needs_review', review_reason: 'multiple_tokens', tech_user_id: null }
    }
    return { status: 'eligible', review_reason: null, tech_user_id: techIds[0] }
  }
  return classifyJob(agents, resolver)
}
