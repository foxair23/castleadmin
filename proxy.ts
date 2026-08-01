import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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
      if (!seg) return NextResponse.redirect('https://castlegaragedoors.com')
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
  if (
    pathname === '/login' ||
    pathname.startsWith('/embed/') ||
    pathname.startsWith('/p/') ||
    // Customer-facing approval: tokenized no-login link (the unguessable token in
    // the path is the authorization). Page + its accept API are both public.
    pathname.startsWith('/approve/') ||
    pathname.startsWith('/api/approve/') ||
    pathname.startsWith('/api/scheduler/') ||
    pathname.startsWith('/api/cron/') ||
    // Inbound webhooks: authenticated by their own shared secret / signature,
    // so they must bypass the login redirect (otherwise the provider's POST is
    // 307'd to /login and never runs).
    pathname === '/api/leads/inbound' ||
    pathname.startsWith('/api/dialpad/')
  ) {
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
