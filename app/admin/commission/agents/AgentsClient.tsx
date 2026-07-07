'use client'

import { useState, useEffect, useCallback } from 'react'

interface Agent {
  agent_id: string | null
  agent_first_name: string | null
  agent_last_name: string | null
  job_count: number
  tech_user_id: string | null
}
interface Tech { id: string; full_name: string }

function agentKey(a: Agent): string {
  return a.agent_id ?? `name:${(a.agent_first_name ?? '').toLowerCase()}|${(a.agent_last_name ?? '').toLowerCase()}`
}

function agentName(a: Agent): string {
  const n = `${a.agent_first_name ?? ''} ${a.agent_last_name ?? ''}`.trim()
  return n || '(unnamed agent)'
}

export default function AgentsClient() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [techs, setTechs] = useState<Tech[]>([])
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  // Note tokens: tech_user_id → token (edited locally, saved per tech).
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const [savingToken, setSavingToken] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/commission/agents')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setAgents(data.agents)
      setTechs(data.techs)
      const tok: Record<string, string> = {}
      for (const t of (data.tokens ?? []) as { tech_user_id: string; token: string }[]) {
        tok[t.tech_user_id] = t.token
      }
      setTokens(tok)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  async function saveToken(techId: string) {
    setSavingToken(techId)
    setError('')
    setSuccess('')
    try {
      const res = await fetch('/api/admin/commission/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tech_user_id: techId, token: tokens[techId] ?? '' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save token')
      setSuccess(data.recompute_error ? 'Token saved (recompute will retry on next sync)' : 'Token saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save token')
    } finally {
      setSavingToken(null)
    }
  }

  useEffect(() => { load() }, [load])

  async function assign(agent: Agent, techId: string) {
    const key = agentKey(agent)
    setSavingKey(key)
    setError('')
    setSuccess('')
    try {
      const res = await fetch('/api/admin/commission/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agent.agent_id,
          agent_first_name: agent.agent_first_name,
          agent_last_name: agent.agent_last_name,
          tech_user_id: techId || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      // Optimistically reflect the change without a full reload.
      setAgents(prev => prev.map(a => (agentKey(a) === key ? { ...a, tech_user_id: techId || null } : a)))
      setSuccess(data.recompute_error ? 'Saved (recompute will retry on next sync)' : 'Mapping saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSavingKey(null)
    }
  }

  const mappedCount = agents.filter(a => a.tech_user_id).length

  return (
    <div className="space-y-4">
      {success && (
        <div className="bg-green-50 border border-green-200 rounded px-4 py-2 text-sm text-green-800">{success}</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded px-4 py-2 text-sm text-red-600">{error}</div>
      )}

      {/* Note tokens — $token$ tags techs write in SF job notes */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-800">Note Tokens</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            A tech writes their token — e.g. <code className="bg-gray-100 px-1 rounded">$kyle$</code> — in a job&rsquo;s
            Tech Notes or Completion Notes in Service Fusion to claim it for commission. A token beats the Agent
            field; jobs without one still use the Agent mapping below. Tokens must be unique (mind the two Davids).
          </p>
        </div>
        <div className="divide-y divide-gray-100">
          {techs.map(t => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-2">
              <span className="text-sm text-gray-900 font-medium w-48 shrink-0">{t.full_name}</span>
              <span className="text-gray-400 text-sm">$</span>
              <input
                type="text"
                value={tokens[t.id] ?? ''}
                onChange={e => setTokens(prev => ({ ...prev, [t.id]: e.target.value }))}
                placeholder="no token"
                className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 w-40 focus:outline-none focus:ring-2 focus:ring-red-400"
              />
              <span className="text-gray-400 text-sm">$</span>
              <button
                onClick={() => saveToken(t.id)}
                disabled={savingToken === t.id}
                className="text-xs bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 disabled:opacity-60"
              >
                {savingToken === t.id ? 'Saving…' : 'Save'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {!loading && (
        <p className="text-sm text-gray-500">
          {agents.length} agent{agents.length === 1 ? '' : 's'} seen on jobs · {mappedCount} mapped
        </p>
      )}

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Agent</th>
                <th className="text-right px-3 py-3 font-medium text-gray-600">Jobs</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Mapped Technician</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>
              ) : agents.length === 0 ? (
                <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400">
                  No agents found on synced jobs yet.
                </td></tr>
              ) : agents.map(a => {
                const key = agentKey(a)
                return (
                  <tr key={key} className={a.tech_user_id ? '' : 'bg-yellow-50/40'}>
                    <td className="px-4 py-2 text-gray-900">{agentName(a)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{a.job_count}</td>
                    <td className="px-4 py-2">
                      <select
                        value={a.tech_user_id ?? ''}
                        disabled={savingKey === key}
                        onChange={e => assign(a, e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 w-56 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-60"
                      >
                        <option value="">— Unmapped —</option>
                        {techs.map(t => (
                          <option key={t.id} value={t.id}>{t.full_name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-400">
        Saving a mapping immediately recomputes commission, so newly-credited jobs move out of the review queue.
        Unmapped agents&rsquo; jobs are held for review until mapped here.
      </p>
    </div>
  )
}
