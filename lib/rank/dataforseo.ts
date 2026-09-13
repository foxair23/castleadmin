import { parseMapsItems, type RankResult } from './grid'

// DataForSEO Google Maps SERP API, Live mode (PRD §8.1). One request = one
// keyword from one coordinate, top 20 results, about $0.002. Auth is HTTP basic
// with the account login and password. Nothing here retries: a failed point is
// stored with its error and the scan moves on.

const BASE = 'https://api.dataforseo.com/v3'

export function isRankProviderConfigured(): boolean {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD)
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64')}`
}

export interface MapsSearchInput { keyword: string; lat: number; lng: number; zoom?: number; depth?: number; match: string }
export interface MapsSearchOutput { results: RankResult[]; cost: number; checkUrl: string | null }

/** Unwrap a DataForSEO response envelope to the first task's first result, throwing on task-level errors. */
export function unwrapTaskResult(json: unknown): { result: Record<string, unknown> | null; cost: number } {
  const env = (json ?? {}) as Record<string, unknown>
  const status = typeof env.status_code === 'number' ? env.status_code : 0
  if (status && status !== 20000) throw new Error(`DataForSEO ${status}: ${String(env.status_message ?? 'error')}`)
  const tasks = Array.isArray(env.tasks) ? env.tasks : []
  const task = (tasks[0] ?? null) as Record<string, unknown> | null
  if (!task) throw new Error('DataForSEO returned no task')
  const tstatus = typeof task.status_code === 'number' ? task.status_code : 0
  if (tstatus && tstatus !== 20000) throw new Error(`DataForSEO task ${tstatus}: ${String(task.status_message ?? 'error')}`)
  const cost = typeof task.cost === 'number' ? task.cost : 0
  const result = Array.isArray(task.result) ? (task.result[0] as Record<string, unknown> | undefined) ?? null : null
  return { result, cost }
}

/** One live Maps search from a coordinate. */
export async function mapsSearch(input: MapsSearchInput): Promise<MapsSearchOutput> {
  if (!isRankProviderConfigured()) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set')
  const depth = input.depth ?? 20
  const body = [{
    keyword: input.keyword,
    location_coordinate: `${input.lat},${input.lng},${input.zoom ?? 14}z`,
    language_code: 'en',
    device: 'desktop',
    depth,
  }]
  const res = await fetch(`${BASE}/serp/google/maps/live/advanced`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`DataForSEO HTTP ${res.status}: ${text.slice(0, 200)}`)
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new Error(`DataForSEO returned non-JSON: ${text.slice(0, 120)}`) }
  const { result, cost } = unwrapTaskResult(json)
  const items = result?.items
  return { results: parseMapsItems(items, input.match, depth), cost, checkUrl: typeof result?.check_url === 'string' ? result.check_url : null }
}

/** Account balance, for the settings card. Null when not configured or the call fails. */
export async function providerBalance(): Promise<number | null> {
  if (!isRankProviderConfigured()) return null
  try {
    const res = await fetch(`${BASE}/appendix/user_data`, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(15_000) })
    const json = (await res.json()) as Record<string, unknown>
    const { result } = unwrapTaskResult(json)
    const money = (result?.money ?? {}) as Record<string, unknown>
    return typeof money.balance === 'number' ? money.balance : null
  } catch { return null }
}
