import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Public short-link resolver: /p/<code> → 302 to the target URL. Counts clicks.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data } = await db.from('short_links').select('target_url').eq('code', code).maybeSingle()
  const target = (data as { target_url: string } | null)?.target_url
  if (!target) return new NextResponse('Link not found', { status: 404 })

  // Count the click (best-effort; never block the redirect).
  try { await db.rpc('bump_short_link', { p_code: code }) } catch { /* ignore */ }

  return NextResponse.redirect(target, 302)
}
