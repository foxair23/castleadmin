-- Genie lookup observability. Customers report the scheduler not recognizing a
-- correct phone/email; the lookup route logged nothing, so we couldn't tell
-- "order wasn't matchable at that moment" from "matched but dropped by the
-- SF-job filter". Log each attempt with a MASKED identifier (no raw PII),
-- how many orders matched before the job filter, and how many were returned.

create table if not exists public.genie_lookup_events (
  id                uuid primary key default gen_random_uuid(),
  method            text,          -- 'phone' | 'email' | 'order' | 'name'
  identifier_masked text,          -- e.g. '***3392', 'm***@gmail.com', '3841960', 'bunnell 92054'
  raw_matched       integer,       -- orders matched by identifier, BEFORE the SF-job filter
  returned          integer,       -- orders actually returned to the customer
  at                timestamptz not null default now()
);
create index if not exists idx_genie_lookup_events_at on public.genie_lookup_events (at desc);

alter table public.genie_lookup_events enable row level security;
create policy "admin_all_genie_lookup_events" on public.genie_lookup_events for all using (public.is_admin());
