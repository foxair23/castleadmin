import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { loadCsatSettings } from '@/lib/csat/config'

// Per-customer review-link bouncer: /r/<surveyId> → stamp the click → 302 to the
// Google review page. Public (proxy.ts). Never a dead end for a customer: an
// unknown id still redirects to the review page.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_req: NextRequest, { params }: { params: Promise<{ surveyId: string }> }) {
  const { surveyId } = await params
  const settings = await loadCsatSettings()
  if (UUID.test(surveyId)) {
    try {
      const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
      await db.from('csat_surveys').update({ review_link_clicked_at: new Date().toISOString() }).eq('id', surveyId).is('review_link_clicked_at', null)
    } catch { /* best-effort; never block the redirect */ }
  }
  return NextResponse.redirect(settings.google_review_url, 302)
}
