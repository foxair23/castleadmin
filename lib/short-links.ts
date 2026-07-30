import crypto from 'crypto'
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

/** Base of the short domain. Set SHORT_LINK_BASE=https://cstle.co once DNS points
 *  there; until then it falls back to the app's own domain (still works). */
export function shortBase(): string {
  return (process.env.SHORT_LINK_BASE || process.env.NEXT_PUBLIC_APP_URL || 'https://hq.castlegaragedoors.com').replace(/\/+$/, '')
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
  return `${shortBase()}/p/${code}`
}
