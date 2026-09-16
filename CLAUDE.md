@AGENTS.md

# Castle Admin

The operational backbone of Castle Garage Doors & Gates (San Diego; garage door
and gate install/repair; veteran-owned, since 1981).

Service Fusion is the company's CRM, and it is not enough on its own. Castle Admin
exists to plug those gaps and to push past them — owning the work Service Fusion
can't do, mirroring its data so we can actually analyze it, and layering automation
and AI on top so Castle moves faster than its competition.

Practically, that means this app now runs: technician piecework payroll, sales
commission, inbound lead capture and self-scheduling, invoice and AR chasing,
customer satisfaction surveys, review and reputation management, vendor ordering
and e-signatures, and an in-house AI agent. Treat it as production infrastructure
for a real business — people get paid from this database and customers are
contacted by it.

## Stack
- Next.js 16 (App Router) + React 19 + Tailwind CSS v4
- Supabase (Postgres + Auth + RLS)
- Anthropic SDK (`@anthropic-ai/sdk`) for all AI features
- Hosting: Vercel (region `sfo1`, cron scheduler) + Supabase
- Tests: Vitest

## Dev Commands
```
npm run dev      # start dev server
npm run build    # production build
npm test         # vitest run (71 test files)
npm run lint     # eslint
npx tsc --noEmit # type-check only
```

## Project Structure
```
app/
  login/  auth/               # login, password reset
  page.tsx                    # root redirect (by role)
  admin/                      # admin console — one folder per domain area
    dashboard/ ops/           # exec dashboard, ops health
    techs/ rates/             # technicians, piecework pay rates
    commission/               # sales commission plans, payments, adjustments
    scheduler/                # booking widgets, leads, service area, capacity
    reviews/                  # Google reviews, CSAT, reputation, rank tracking
    cassie/                   # AI agent console
    vendor-orders/            # vendor portal orders, Clopay, e-sign
    remittances/              # payment remittance matching
    invoice-reminders/ leadgen/ marketing/ mailchimp/ notifications/
    sf/ sf-sync/ integrations/ action-items/ sales/
  sales/                      # sales-role console (leads, approvals, leaderboard)
  tech/                       # technician "My Week" — jobs, bulk update
  scheduler/ embed/           # public booking widgets (embedded on marketing site)
  approve/ sign/ r/ p/        # public tokenized links (approvals, e-sign, review
                              #   bouncer, short links) — no login, token IS the auth
  api/
    cron/                     # 40 scheduled jobs (see vercel.json)
    admin/ tech/ commission/  # session-authed APIs
    scheduler/ genie-scheduler/ approve/ sign/   # public/widget APIs
    leads/ dialpad/ cassie/ remittance/ sf-notes/ vendor-orders/ ops/
                              # inbound webhooks + Chrome extension (secret-authed)
lib/
  supabase/                   # browser, server, and service-role clients + generated types
  week.ts                     # week math, piecework pay calculation, formatting
  sf-mirror/                  # Service Fusion sync engine + mirror
  commission/                 # commission engine (calc.ts is pure, no I/O)
  agent/                      # "Cassie" — AI agent (email + chat channels)
  scheduler/ leadgen/         # booking, lead capture and matching
  reputation/ google-reviews/ rank/ csat/    # reviews, CSAT, SEO rank
  vendor-orders/ clopay-sts/ clopay-dc/ esign/    # vendor ordering + signatures
  remittance/ invoice-reminders/ ar-aging/   # money in
  notifications/ inbound/ dialpad/ mailchimp/ marketing/
  analytics/ action-items/ approvals/ ops/ crm/ matching/ files/
  cron/pt-gate.ts             # Pacific-time guard for UTC cron schedules
components/                   # shared UI (small — most UI is colocated by route)
supabase/
  schema.sql                  # human-readable baseline reference
  migrations/                 # 000–143+, applied in order; 000 mirrors schema.sql
chrome-extension/             # Service Fusion remittance helper extension
__tests__/                    # Vitest suites, mostly pure-logic
proxy.ts                      # auth guard (Next.js 16 proxy/middleware)
```

## Database
- **Migrations are the source of truth.** Add a new numbered file in
  `supabase/migrations/` (e.g. `144_thing.sql`). Write them **idempotent**
  (`create table if not exists`, `add column if not exists`) — they get re-run.
- `supabase/schema.sql` is a human-readable baseline only. Keep
  `000_base_schema.sql` in sync with it if you change the baseline.
- **Never write a destructive migration casually.** There is no undo. Prefer
  additive changes and soft deletes; the codebase already does this deliberately
  (see the SF mirror's soft-delete design).
- Generated types live in `lib/supabase/database.types.ts`.

## Auth, Roles, and RLS
- Roles in `profiles.role`: `technician`, `admin`, `sales`.
- `proxy.ts` guards everything. Public paths are enumerated in `isPublicPath()` —
  **if you add a webhook, widget API, or tokenized link, add it there**, or the
  provider's POST gets 307'd to `/login` and fails silently.
- Technicians cannot self-register; admins create accounts in Manage Technicians.
- Three Supabase clients in `lib/supabase/`:
  - `client.ts` — browser, anon key, RLS enforced
  - `server.ts` → `createClient()` — server, user session, RLS enforced
  - `server.ts` → `createServiceClient()` — **service role, bypasses ALL RLS**
- Use the service-role client only where it's genuinely required, and always
  check the caller's role yourself first. RLS is not protecting you there.

## Cron Jobs
- Declared in `vercel.json`, implemented under `app/api/cron/`.
- Every handler must gate on `Bearer ${process.env.CRON_SECRET}` and return 401
  otherwise.
- Vercel cron runs on **fixed UTC**, which drifts an hour across DST. To pin a job
  to a Pacific wall-clock hour, schedule **both** candidate UTC hours
  (e.g. `0 14,15 * * 1-6`) and call `isPtHour()` from `lib/cron/pt-gate.ts` at the
  top of the handler so the wrong firing no-ops.
- Set `export const maxDuration` on anything long-running.

## Key Business Rules
**Piecework payroll**
- Workweek: Monday–Sunday, America/Los_Angeles.
- Submission deadline: Tuesday 23:59 PT of the following week.
- Pay formula: flat = `base_rate`; tiered = `base_rate + (qty-1) × additional_rate`.
- Submitted week totals are frozen — rate changes never retroactively recalculate.

**Sales commission** (`lib/commission/calc.ts`, pure functions)
- A job belongs to the month its work was **completed**.
- Target and tier are measured against **received** (collected) revenue.
- Two-tier: `min(R, target)·rate_below + max(0, R−target)·rate_above`.
- Completed-but-unpaid work shows a *projected* commission layered on top, so the
  real figures never move.

## UI Rules
- **Always add `text-gray-900` to every `<input>`, `<select>`, and `<textarea>`.**
  Without it, typed text inherits the page's muted color and becomes unreadable on
  a white background. This has caused bugs before — don't skip it.
- For anything customer-facing or branded, use the `castle-garage-design` skill.

## Integrations
| System | Role |
|---|---|
| Service Fusion | CRM / source of truth for jobs, customers, invoices; mirrored locally |
| Anthropic (Claude) | Cassie agent, review replies, lead + remittance matching |
| Dialpad | phone + SMS (CSAT surveys, inbound call logging) |
| Resend | transactional + inbound email |
| Gmail / Google Chat | Cassie's email and chat channels |
| Google Business Profile | reviews, posts, performance |
| DataForSEO | local rank tracking |
| Mailchimp | marketing audience sync |
| Clopay / Home Depot–Genie | vendor orders, ship-to-store, installer POs, self-scheduling |

## Environment Variables
There is no `.env.local.example` in the repo. Required vars are referenced
directly in code — grep `process.env.` to find the current set. The core ones:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side only — never expose to the browser)
- `CRON_SECRET` (all cron handlers)
- `ANTHROPIC_API_KEY`, `SF_CLIENT_ID` / `SF_CLIENT_SECRET`, `RESEND_API_KEY`,
  `DIALPAD_API_TOKEN`, and the per-integration keys listed above.

## Conventions
- **Comments explain *why*, not *what*.** This codebase documents the trap that
  motivated the code (DST drift, silent 307s, PostgREST's 1000-row cap). Match
  that — when you fix a non-obvious bug, leave the reason behind.
- Put business logic in `lib/` as pure functions and test it there; keep routes and
  components thin. `__tests__/` is mostly pure-logic, no database required.
- Import alias is `@/` → repo root.
- Read `node_modules/next/dist/docs/` before writing Next.js code (see AGENTS.md).
