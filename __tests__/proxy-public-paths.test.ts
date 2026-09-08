import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { isPublicPath } from '@/proxy'

// A route that authenticates itself and is NOT listed as public gets 307'd to /login by
// the auth guard. Nothing errors on our side — the caller just sees "not responding",
// which is how the Google Chat endpoint sat broken. So assert the list directly.
describe('isPublicPath', () => {
  it('exempts endpoints that carry their own authorization', () => {
    for (const p of [
      '/api/cassie/chat/events',      // Google-signed bearer token
      '/api/leads/inbound',           // shared secret
      '/api/dialpad/webhook',         // provider signature
      '/api/cron/cassie-poll',        // cron secret
      '/api/remittance/apply-queue',  // extension shared token
      '/api/sf-notes/queue',
      '/api/vendor-orders/sf-lines-queue',
      '/api/ops/session-alert',
      '/api/approve/accept',
      '/api/scheduler/slots',
    ]) expect(isPublicPath(p), p).toBe(true)
  })

  it('still guards everything session-authed', () => {
    for (const p of [
      '/admin/cassie', '/tech', '/api/admin/techs', '/api/cassie/gmail/authorize', '/',
    ]) expect(isPublicPath(p), p).toBe(false)
  })

  it('does not exempt by prefix where an exact path was meant', () => {
    // /api/cassie/* is otherwise session-authed; only the events endpoint is public.
    expect(isPublicPath('/api/cassie/chat/events/../../gmail/callback')).toBe(false)
    expect(isPublicPath('/api/leads/inbound/anything')).toBe(false)
  })

  it('lists every route the Chat app posts to', () => {
    // Belt and braces: the events route exists on disk at the path we exempt.
    const routes: string[] = []
    const walk = (dir: string, url: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e)
        if (statSync(full).isDirectory()) walk(full, `${url}/${e}`)
        else if (e === 'route.ts') routes.push(url)
      }
    }
    walk(join(process.cwd(), 'app/api/cassie'), '/api/cassie')
    expect(routes).toContain('/api/cassie/chat/events')
    // And that route verifies a Google token rather than a session.
    expect(readFileSync(join(process.cwd(), 'app/api/cassie/chat/events/route.ts'), 'utf8')).toContain('verifyEventToken')
  })
})
