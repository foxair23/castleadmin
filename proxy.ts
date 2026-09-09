import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { marketingUrl } from '@/lib/config/domains'

/** Routes that carry their own authorization and must never be redirected to /login.
 *  Exported so it can be tested: a provider's POST that gets 307'd to /login fails
 *  silently on our side — the caller sees only "not responding" — so the list is easy
 *  to leave a route out of and hard to notice. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/embed/') ||
    pathname.startsWith('/p/') ||
    // Customer-facing approval: tokenized no-login link (the unguessable token in
    // the path is the authorization). Page + its accept API are both public.
    pathname.startsWith('/approve/') ||
    pathname.startsWith('/api/approve/') ||
    // E-sign: the customer's and the technician's signing links (token in the path).
    pathname.startsWith('/sign/') ||
    pathname.startsWith('/api/sign/') ||
    pathname.startsWith('/api/scheduler/') ||
    // The Genie booking widget's API: widget-key gated with a CORS allowlist, called by
    // customers on the public embed page who have no login and never will. Was never on
    // this list — every lookup and booking POST was 307'd to /login and died there.
    pathname.startsWith('/api/genie-scheduler/') ||
    pathname.startsWith('/api/cron/') ||
    // Inbound webhooks: authenticated by their own shared secret / signature,
    // so they must bypass the login redirect (otherwise the provider's POST is
    // 307'd to /login and never runs).
    pathname === '/api/leads/inbound' ||
    pathname.startsWith('/api/dialpad/') ||
    // Google Chat events carry a Google-signed bearer token that the route verifies
    // against Google's published certs, so there is no session to redirect to.
    pathname === '/api/cassie/chat/events' ||
    // Remittance endpoints are token/secret-authed (inbound webhook + the Chrome
    // extension's apply queue/callback), not session-authed — so they must skip
    // the login redirect, or the extension's CORS preflight is 307'd and fails.
    pathname.startsWith('/api/remittance/') ||
    // Same for the extension's SF-note queue, vendor-portal order ingest, and
    // session-logged-out alert — shared-token authed, called cross-origin by the
    // extension.
    pathname.startsWith('/api/sf-notes/') ||
    pathname.startsWith('/api/vendor-orders/') ||
    pathname.startsWith('/api/ops/')
  )
}

export async function proxy(request: NextRequest) {
  // Short-link host (e.g. go.cstle.co): treat any root path as a short code and
  // rewrite to the /p/[code] resolver, so links are go.cstle.co/<code> with no
  // prefix. Scoped to that host only — the app's own domain routes normally.
  // Done first (before any auth work) since these are public redirects.
  const shortBase = process.env.SHORT_LINK_BASE
  if (shortBase) {
    let shortHost: string | null = null
    try { shortHost = new URL(shortBase).hostname } catch { /* ignore bad value */ }
    if (shortHost && request.nextUrl.hostname === shortHost) {
      const seg = request.nextUrl.pathname.replace(/^\/+/, '').split('/')[0]
      if (!seg) return NextResponse.redirect(marketingUrl())
      const url = request.nextUrl.clone()
      url.pathname = `/p/${seg}`
      return NextResponse.rewrite(url)
    }
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // Public routes — no auth required
  if (isPublicPath(pathname)) {
    if (pathname === '/login' && user) {
      return NextResponse.redirect(new URL('/', request.url))
    }
    return supabaseResponse
  }

  // Protected routes — redirect to login if not authenticated, preserving the
  // intended destination so e.g. an emailed "Done" link returns here post-login.
  if (!user) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname + request.nextUrl.search)
    return NextResponse.redirect(loginUrl)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
