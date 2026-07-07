/**
 * Commission eligibility rule tests (TRD §3.2–§3.3, acceptance criteria 2 & 3).
 *
 * Covers agent→tech resolution (id first, then name) and the agent-count
 * classification rules: one mapped → eligible; multiple → review; unmapped →
 * review; zero → not eligible.
 */

import { describe, it, expect } from 'vitest'
import {
  buildResolver,
  classifyJob,
  type AgentMapping,
  type AgentOnJob,
} from '@/lib/commission/eligibility'

const KYLE = 'tech-kyle'
const MARIA = 'tech-maria'

const MAP: AgentMapping[] = [
  { tech_user_id: KYLE, agent_id: '980496477', agent_first_name: 'Kyle', agent_last_name: 'Hefner' },
  { tech_user_id: MARIA, agent_id: null, agent_first_name: 'Maria', agent_last_name: 'Sauza' },
]

function agent(id: string | null, first: string | null, last: string | null): AgentOnJob {
  return { agent_id: id, agent_first_name: first, agent_last_name: last }
}

describe('buildResolver — agent → tech matching (§3.2)', () => {
  const resolver = buildResolver(MAP)

  it('matches by agent_id when present', () => {
    expect(resolver.resolve(agent('980496477', 'Whoever', 'Different'))).toBe(KYLE)
  })

  it('falls back to first+last name (case-insensitive) when no id match', () => {
    expect(resolver.resolve(agent(null, 'maria', 'sauza'))).toBe(MARIA)
    expect(resolver.resolve(agent('99999', 'Maria', 'Sauza'))).toBe(MARIA)
  })

  it('returns null for an unmapped agent', () => {
    expect(resolver.resolve(agent('123', 'Unknown', 'Person'))).toBeNull()
  })
})

describe('classifyJob — agent-count rules (§3.3, criterion 3)', () => {
  const resolver = buildResolver(MAP)

  it('exactly one mapped agent → eligible, credits that tech', () => {
    const c = classifyJob([agent('980496477', 'Kyle', 'Hefner')], resolver)
    expect(c).toEqual({ status: 'eligible', review_reason: null, tech_user_id: KYLE })
  })

  it('exactly one unmapped agent → needs_review / unmapped_agent', () => {
    const c = classifyJob([agent('555', 'New', 'Guy')], resolver)
    expect(c).toEqual({ status: 'needs_review', review_reason: 'unmapped_agent', tech_user_id: null })
  })

  it('more than one agent → needs_review / multiple_agents, excluded', () => {
    const c = classifyJob(
      [agent('980496477', 'Kyle', 'Hefner'), agent(null, 'Maria', 'Sauza')],
      resolver,
    )
    expect(c).toEqual({ status: 'needs_review', review_reason: 'multiple_agents', tech_user_id: null })
  })

  it('multiple agents flags even when none are mapped', () => {
    const c = classifyJob([agent('1', 'A', 'A'), agent('2', 'B', 'B')], resolver)
    expect(c?.status).toBe('needs_review')
    expect(c?.review_reason).toBe('multiple_agents')
  })

  it('zero agents → null (not commission-eligible, no row)', () => {
    expect(classifyJob([], resolver)).toBeNull()
  })
})

// ── Note tokens ($kyle$-style tags) ──────────────────────────────────────────

import { buildTokenMap, classifyJobWithTokens, extractNoteTokens } from '@/lib/commission/eligibility'

const TOKENS = buildTokenMap([
  { token: 'kyle', tech_user_id: KYLE },
  { token: 'maria', tech_user_id: MARIA },
])

describe('extractNoteTokens', () => {
  it('finds $token$ tags across fields, case-insensitively, deduped', () => {
    expect(extractNoteTokens('Fixed spring $Kyle$', 'done $kyle$ thanks')).toEqual(['kyle'])
    expect(extractNoteTokens('$kyle$ and $maria$ split')).toEqual(['kyle', 'maria'])
  })

  it('ignores plain dollar amounts and null fields', () => {
    expect(extractNoteTokens('collected $150 cash, quoted $1,200', null)).toEqual([])
    expect(extractNoteTokens(null, undefined)).toEqual([])
  })

  it('does not treat $100 and $ alone as tokens but allows digits inside a tag', () => {
    // "$100 and $" — the text between the two $ signs contains spaces → no match.
    expect(extractNoteTokens('$100 and $')).toEqual([])
    expect(extractNoteTokens('$davidv2$')).toEqual(['davidv2'])
  })
})

describe('classifyJobWithTokens — token beats agent, fallback otherwise', () => {
  const resolver = buildResolver(MAP)
  const unmappedAgent = [agent(null, 'Random', 'Person')]

  it('one known token → eligible for that tech, even when agents disagree', () => {
    const c = classifyJobWithTokens(['maria'], TOKENS, [agent('980496477', 'Kyle', 'Hefner')], resolver)
    expect(c).toEqual({ status: 'eligible', review_reason: null, tech_user_id: MARIA })
  })

  it('unknown token → needs_review / unmapped_token (typos surface, not silently dropped)', () => {
    const c = classifyJobWithTokens(['kylee'], TOKENS, [], resolver)
    expect(c).toEqual({ status: 'needs_review', review_reason: 'unmapped_token', tech_user_id: null })
  })

  it('tokens for two different techs → needs_review / multiple_tokens', () => {
    const c = classifyJobWithTokens(['kyle', 'maria'], TOKENS, [], resolver)
    expect(c).toEqual({ status: 'needs_review', review_reason: 'multiple_tokens', tech_user_id: null })
  })

  it('no tokens → falls back to agent classification', () => {
    expect(classifyJobWithTokens([], TOKENS, [agent('980496477', 'Kyle', 'Hefner')], resolver))
      .toEqual({ status: 'eligible', review_reason: null, tech_user_id: KYLE })
    expect(classifyJobWithTokens([], TOKENS, unmappedAgent, resolver))
      .toEqual({ status: 'needs_review', review_reason: 'unmapped_agent', tech_user_id: null })
    expect(classifyJobWithTokens([], TOKENS, [], resolver)).toBeNull()
  })
})
