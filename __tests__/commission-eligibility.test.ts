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
