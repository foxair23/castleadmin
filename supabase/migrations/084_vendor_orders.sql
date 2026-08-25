-- Third-party vendor order log (shared spine across vendor portals).
--
-- Several vendors (first: Genie installs via Home Depot, on the Oracle WebCenter
-- portal at install.openings.net) hand us orders through clunky web portals with
-- no API. The browser extension reads those portals in the user's logged-in
-- session (content-script DOM scrape) and posts orders here. This table is the
-- single log every downstream use reads from:
--   1. status tracking (kills "check my order" calls from customers/HD stores),
--   2. auto-creating the SF job (Phase 2, review-first),
--   3. a public status-lookup page (Phase 3).
--
-- Vendor-agnostic on purpose: `vendor` keys the source, so the next portal drops
-- in with its own scraper + field mapping and reuses everything here.

create table if not exists public.vendor_orders (
  id                 uuid primary key default gen_random_uuid(),
  vendor             text not null,                 -- 'genie_thd' | future vendors
  external_id        text not null,                 -- the vendor's order number (e.g. '3819112')

  -- List-level fields (present from the orders grid).
  status            text,                           -- 'Open' | 'Closed' | 'Cancelled' (raw portal value)
  next_step         text,                           -- 'Schedule / Follow-up Installation', etc. — the automation trigger
  order_type        text,                           -- 'THD - Labor Only'
  customer_name     text,                           -- 'MESSERSCHMIDT, KATHY'
  customer_po       text,                           -- HD PO — maps to SF po_number (ties into remittance matching)
  store_number      text,                           -- HD store # → SF custom "Home Depot Store #"
  order_date        date,
  schedule_date     date,

  -- Detail-level fields (filled once the order's detail page is scraped).
  street_address    text,
  city              text,
  state_prov        text,
  postal_code       text,
  phone             text,
  email             text,
  scope             text,                           -- item description / install scope ('INSTALL RETAIL GDO ...')
  detail_scraped_at timestamptz,

  -- Linkage / lifecycle.
  sf_job_id         text,                           -- set when the SF job is created (Phase 2)
  raw               jsonb not null default '{}'::jsonb,   -- full scraped payload (list row + detail), nothing discarded
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (vendor, external_id)
);

create index if not exists idx_vendor_orders_vendor_status on public.vendor_orders (vendor, status);
create index if not exists idx_vendor_orders_last_seen on public.vendor_orders (last_seen_at);

-- Append-only history so we can show a timeline and detect what changed when
-- (status flips, next-step changes, first seen, SF job created, …).
create table if not exists public.vendor_order_events (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.vendor_orders(id) on delete cascade,
  event_type  text not null,                        -- 'seen' | 'status_change' | 'next_step_change' | 'detail_scraped' | 'sf_job_created'
  from_value  text,
  to_value    text,
  detail      jsonb,
  at          timestamptz not null default now()
);
create index if not exists idx_vendor_order_events_order on public.vendor_order_events (order_id, at);

alter table public.vendor_orders       enable row level security;
alter table public.vendor_order_events enable row level security;
drop policy if exists "admin_all_vendor_orders"       on public.vendor_orders;
create policy "admin_all_vendor_orders"       on public.vendor_orders       for all using (public.is_admin());
drop policy if exists "admin_all_vendor_order_events" on public.vendor_order_events;
create policy "admin_all_vendor_order_events" on public.vendor_order_events for all using (public.is_admin());
