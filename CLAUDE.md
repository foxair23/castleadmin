@AGENTS.md

# Castle Garage Doors & Gates — Piecework Payroll App

## Stack
- Next.js 16 (App Router) + Tailwind CSS
- Supabase (Postgres + Auth + RLS)
- Hosting: Vercel + Supabase

## Dev Commands
```
npm run dev      # start dev server
npm run build    # production build
npx tsc --noEmit # type-check only
```

## Project Structure
```
app/
  login/         # login page (public)
  page.tsx        # root redirect (→ /admin or /tech based on role)
  admin/
    page.tsx       # weekly summary (default: previous week)
    rates/         # manage pay rates
    techs/         # manage technicians
  tech/
    page.tsx       # My Week screen
    jobs/new/      # add job
    jobs/[id]/edit/ # edit job
  api/admin/techs/ # server-side admin API (service role)
components/
  Navbar.tsx
lib/
  supabase/
    client.ts      # browser client
    server.ts      # server client
  week.ts          # week math, pay calculation, formatting
supabase/
  schema.sql       # full schema + RLS + seed data
proxy.ts           # auth guard (Next.js 16 proxy/middleware)
```

## Environment Variables
Copy `.env.local.example` → `.env.local` and fill in Supabase credentials:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (admin API routes only)

## Database Setup
Run `supabase/schema.sql` in the Supabase SQL editor. It creates all tables,
RLS policies, triggers, and seeds the 9 initial job types.

## Key Business Rules
- Workweek: Monday–Sunday, America/Los_Angeles timezone
- Submission deadline: Wednesday 23:59 PT of the following week
- Pay formula: flat = base_rate; tiered = base_rate + (qty-1) × additional_rate
- Submitted week totals are frozen — rate changes don't retroactively recalculate
- Techs cannot self-register; admin creates accounts via Manage Technicians

## UI Rules
- **Always add `text-gray-900` to every `<input>`, `<select>`, and `<textarea>`.**
  Without it, typed text inherits the page's muted color and becomes unreadable on
  a white background. This has caused bugs before — don't skip it.

## Auth Flow
- Admin creates technician accounts (email + temp password, shared manually)
- Login via Supabase email/password auth
- Role stored in `profiles` table; proxy.ts guards all routes
- Admin: `/admin` routes; Technician: `/tech` routes
