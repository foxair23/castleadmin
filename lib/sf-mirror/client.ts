/**
 * Service Fusion Mirror Client — GET-only.
 *
 * Rules enforced at this layer (never at call sites):
 *   1. Every /jobs request always includes a sort parameter (Known Issue: hangs without it).
 *   2. per-page is always 50 (the API maximum) unless explicitly overridden.
 *   3. 429 → exponential backoff + jitter, respects Retry-After header, resumes same page.
 *   4. 5xx / network error → retry up to MAX_RETRIES with backoff, then throw.
 *   5. No POST / PUT / PATCH / DELETE methods exist on this client.
 */

const SF_BASE = 'https://api.servicefusion.com/v1'

const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const DEFAULT_POLITENESS_MS = 200

export interface SfPageMeta {
  totalCount: number
  pageCount: number
  currentPage: number
  perPage: number
}

export interface SfPage<T = unknown> {
  items: T[]
  _meta: SfPageMeta
}

export interface SfMirrorClientOptions {
  /** Returns a valid Bearer token. Injected so tests don't need a real SF account. */
  getToken: () => Promise<string>
  /** Injected fetch for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
  /** Minimum delay between consecutive requests (ms). Default 200. */
  politenessDelayMs?: number
}

function jitter(base: number): number {
  return base + Math.random() * base * 0.3
}

function backoffMs(attempt: number): number {
  return Math.min(jitter(BASE_BACKOFF_MS * 2 ** attempt), MAX_BACKOFF_MS)
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function createSfMirrorClient(opts: SfMirrorClientOptions) {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const politeness = opts.politenessDelayMs ?? DEFAULT_POLITENESS_MS

  /**
   * Single GET request to the SF API.
   * Retries on 429 (with Retry-After) and 5xx (with exponential backoff).
   * Throws after MAX_RETRIES failures.
   */
  async function get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const merged = applyDefaults(path, params)
    const token = await opts.getToken()

    const url = new URL(`${SF_BASE}${path}`)
    for (const [k, v] of Object.entries(merged)) url.searchParams.set(k, v)

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)

      let resp: Response
      try {
        resp = await fetchFn(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        })
      } catch (err) {
        clearTimeout(timeout)
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt))
          continue
        }
        throw new Error(`SF network error on ${path}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        clearTimeout(timeout)
      }

      if (resp.status === 429) {
        const retryAfter = resp.headers.get('Retry-After')
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoffMs(attempt)
        await sleep(waitMs)
        continue
      }

      if (resp.status >= 500) {
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt))
          continue
        }
        throw new Error(`SF server error (${resp.status}) on ${path} after ${MAX_RETRIES} retries`)
      }

      if (!resp.ok) {
        throw new Error(`SF API error (${resp.status}) on ${path}: ${await resp.text()}`)
      }

      return resp.json()
    }

    throw new Error(`SF request to ${path} failed after ${MAX_RETRIES} retries`)
  }

  /**
   * Paginate through all pages of a list endpoint, yielding each page's items.
   * startPage lets a backfill resume from where it left off.
   * A politeness delay is inserted between page requests.
   */
  async function* paginateAll<T>(
    path: string,
    params: Record<string, string> = {},
    startPage = 1,
  ): AsyncGenerator<{ items: T[]; meta: SfPageMeta; page: number }> {
    let page = startPage

    while (true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await get(path, { ...params, page: String(page) })) as any
      const items: T[] = json?.items ?? []
      const meta: SfPageMeta = json?._meta ?? {
        totalCount: items.length,
        pageCount: page,
        currentPage: page,
        perPage: 50,
      }

      yield { items, meta, page }

      if (page >= meta.pageCount) break
      page++

      await sleep(politeness)
    }
  }

  return { get, paginateAll }
}

/**
 * Apply mandatory defaults before any request:
 *   - /jobs always gets sort=-start_date (Known Issue: hangs without sort)
 *   - per-page defaults to 50 (the API maximum)
 *
 * Note: do NOT add a sort default for /invoices — SF rejects it and every
 * invoices request fails. Newest-first coverage is achieved by paginating
 * backwards from the last page instead (reversePages in the sync engine).
 */
function applyDefaults(path: string, params: Record<string, string>): Record<string, string> {
  const out = { ...params }
  if (!out['per-page']) out['per-page'] = '50'
  if (path.startsWith('/jobs') && !out['sort']) out['sort'] = '-start_date'
  return out
}

// ─── Default singleton using the real SF token ─────────────────────────────
// Lazy-initialised so importing this module in tests doesn't trigger Supabase.
let _defaultClient: ReturnType<typeof createSfMirrorClient> | null = null

function defaultClient() {
  if (!_defaultClient) {
    // Dynamic import at call time keeps the server-side Supabase dependency
    // out of the module's top-level scope, which would break test imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getToken } = require('@/lib/crm/service-fusion') as { getToken: () => Promise<string> }
    _defaultClient = createSfMirrorClient({ getToken })
  }
  return _defaultClient
}

export function sfMirrorGet(path: string, params?: Record<string, string>): Promise<unknown> {
  return defaultClient().get(path, params)
}

export function sfMirrorPaginateAll<T>(
  path: string,
  params?: Record<string, string>,
  startPage?: number,
) {
  return defaultClient().paginateAll<T>(path, params, startPage)
}
