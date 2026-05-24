/**
 * Acceptance criterion 8:
 * "A code review and unit test confirm the SF client issues only HTTP GET requests."
 *
 * Also verifies Known Issue 1:
 * "Every /jobs request must include a sort parameter."
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSfMirrorClient } from '@/lib/sf-mirror/client'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeSinglePageJson(items: unknown[]) {
  return {
    items,
    _meta: { totalCount: items.length, pageCount: 1, currentPage: 1, perPage: 50 },
  }
}

// ─── Test setup ───────────────────────────────────────────────────────────────

const getToken = vi.fn(async () => 'test-token')

function makeClient(fetchFn: typeof fetch) {
  return createSfMirrorClient({ getToken, fetch: fetchFn, politenessDelayMs: 0 })
}

beforeEach(() => {
  getToken.mockClear()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SF mirror client — GET-only enforcement', () => {
  it('issues only GET requests, never POST/PUT/PATCH/DELETE', async () => {
    const capturedMethods: string[] = []

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedMethods.push(init?.method ?? 'GET')
      return makeOkResponse(makeSinglePageJson([{ id: '1' }]))
    }) as unknown as typeof fetch

    const client = makeClient(mockFetch)

    // Call get() for several different endpoints
    await client.get('/customers')
    await client.get('/jobs')
    await client.get('/invoices')
    await client.get('/estimates')
    await client.get('/techs')

    // Consume a full paginated run
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _page of client.paginateAll('/jobs')) { /* drain */ }

    // Every request must have been GET
    expect(capturedMethods.length).toBeGreaterThan(0)
    for (const method of capturedMethods) {
      expect(method).toBe('GET')
    }
  })

  it('client object exposes no POST/PUT/PATCH/DELETE methods', () => {
    const client = makeClient(vi.fn() as unknown as typeof fetch)
    expect((client as Record<string, unknown>)['post']).toBeUndefined()
    expect((client as Record<string, unknown>)['put']).toBeUndefined()
    expect((client as Record<string, unknown>)['patch']).toBeUndefined()
    expect((client as Record<string, unknown>)['delete']).toBeUndefined()
  })
})

describe('Known Issue 1 — /jobs sort parameter required', () => {
  it('adds sort=-start_date to /jobs requests that have no sort', async () => {
    const capturedUrls: string[] = []

    const mockFetch = vi.fn(async (url: string) => {
      capturedUrls.push(url)
      return makeOkResponse(makeSinglePageJson([]))
    }) as unknown as typeof fetch

    const client = makeClient(mockFetch)
    await client.get('/jobs')

    expect(capturedUrls).toHaveLength(1)
    const u = new URL(capturedUrls[0])
    expect(u.searchParams.get('sort')).toBe('-start_date')
  })

  it('preserves an explicitly provided sort on /jobs', async () => {
    const capturedUrls: string[] = []

    const mockFetch = vi.fn(async (url: string) => {
      capturedUrls.push(url)
      return makeOkResponse(makeSinglePageJson([]))
    }) as unknown as typeof fetch

    const client = makeClient(mockFetch)
    await client.get('/jobs', { sort: '-created_at' })

    const u = new URL(capturedUrls[0])
    expect(u.searchParams.get('sort')).toBe('-created_at')
  })

  it('does NOT add sort to non-/jobs endpoints', async () => {
    const capturedUrls: string[] = []

    const mockFetch = vi.fn(async (url: string) => {
      capturedUrls.push(url)
      return makeOkResponse(makeSinglePageJson([]))
    }) as unknown as typeof fetch

    const client = makeClient(mockFetch)
    await client.get('/customers')
    await client.get('/invoices')

    for (const url of capturedUrls) {
      const u = new URL(url)
      expect(u.searchParams.get('sort')).toBeNull()
    }
  })
})

describe('per-page default', () => {
  it('defaults per-page to 50 on all requests', async () => {
    const capturedUrls: string[] = []

    const mockFetch = vi.fn(async (url: string) => {
      capturedUrls.push(url)
      return makeOkResponse(makeSinglePageJson([]))
    }) as unknown as typeof fetch

    const client = makeClient(mockFetch)
    await client.get('/customers')
    await client.get('/jobs')

    for (const url of capturedUrls) {
      const u = new URL(url)
      expect(u.searchParams.get('per-page')).toBe('50')
    }
  })
})

describe('429 retry behaviour', () => {
  it('retries on 429 and eventually succeeds', async () => {
    let calls = 0

    const mockFetch = vi.fn(async () => {
      calls++
      if (calls < 3) {
        return new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 })
      }
      return makeOkResponse({ result: 'ok' })
    }) as unknown as typeof fetch

    const client = createSfMirrorClient({
      getToken,
      fetch: mockFetch,
      politenessDelayMs: 0,
    })

    const result = await client.get('/customers')
    expect(calls).toBe(3)
    expect(result).toEqual({ result: 'ok' })
  })
})

describe('paginateAll', () => {
  it('fetches all pages and yields each page', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      const u = new URL(url)
      const page = parseInt(u.searchParams.get('page') ?? '1', 10)
      return makeOkResponse({
        items: [{ id: String(page) }],
        _meta: { totalCount: 3, pageCount: 3, currentPage: page, perPage: 50 },
      })
    }) as unknown as typeof fetch

    const client = makeClient(mockFetch)
    const pages: unknown[][] = []
    for await (const { items } of client.paginateAll('/customers')) {
      pages.push(items)
    }

    expect(pages).toHaveLength(3)
    expect(pages[0]).toEqual([{ id: '1' }])
    expect(pages[2]).toEqual([{ id: '3' }])
  })

  it('resumes from startPage for backfill resumability', async () => {
    const requestedPages: number[] = []

    const mockFetch = vi.fn(async (url: string) => {
      const u = new URL(url)
      const page = parseInt(u.searchParams.get('page') ?? '1', 10)
      requestedPages.push(page)
      return makeOkResponse({
        items: [],
        _meta: { totalCount: 0, pageCount: 5, currentPage: page, perPage: 50 },
      })
    }) as unknown as typeof fetch

    const client = makeClient(mockFetch)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _p of client.paginateAll('/customers', {}, 3)) { /* drain */ }

    expect(requestedPages[0]).toBe(3)
    expect(requestedPages).toEqual([3, 4, 5])
  })
})
