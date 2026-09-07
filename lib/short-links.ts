import crypto from 'crypto'
import { appUrl } from '@/lib/config/domains'
import { createClient } from '@supabase/supabase-js'

// Short links — turn long SF pay URLs into cstle.co/p/<code> for SMS/email.
// Codes are a deterministic hash of the target so the same URL always yields the
// same code (idempotent, no duplicates).

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

/** Dedicated short domain, e.g. https://go.cstle.co (set SHORT_LINK_BASE). */
export function shortBase(): string {
  return (process.env.SHORT_LINK_BASE || '').replace(/\/+$/, '')
}
function appBase(): string {
  return appUrl()
}

/**
 * Full short URL for a code. On the dedicated short domain the code sits at the
 * root (go.cstle.co/<code>) — the middleware rewrites that host's requests to
 * the /p/[code] resolver. Without SHORT_LINK_BASE we fall back to the app domain
 * with the /p/ prefix (<app>/p/<code>), which routes normally.
 */
export function shortUrl(code: string): string {
  const base = shortBase()
  return base ? `${base}/${code}` : `${appBase()}/p/${code}`
}

/** Deterministic 8-char base62 code for a URL (~48 bits; collisions negligible). */
export function shortCode(targetUrl: string): string {
  const hash = crypto.createHash('sha256').update(targetUrl).digest('hex')
  let num = parseInt(hash.slice(0, 12), 16) // 48 bits — within Number.MAX_SAFE_INTEGER
  let out = ''
  for (let i = 0; i < 8; i++) { out = BASE62[num % 62] + out; num = Math.floor(num / 62) }
  return out
}

/** Get-or-create a short link for a URL; returns the full short URL. */
export async function ensureShortLink(targetUrl: string): Promise<string> {
  const code = shortCode(targetUrl)
  try {
    await db().from('short_links').upsert({ code, target_url: targetUrl }, { onConflict: 'code', ignoreDuplicates: true })
  } catch { /* best-effort; still return the short URL */ }
  return shortUrl(code)
}
