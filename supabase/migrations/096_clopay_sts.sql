-- Clopay STS (ship-to-store) orders. Clopay emails these delivery orders (mixed
-- with non-STS orders); the marker is the token "STS" in an order line. We ingest
-- them into vendor_orders (vendor='clopay_sts'), email the Distribution Center for
-- details, attach the acknowledgement PDF the DC replies with, and track a status
-- pipeline. Reuses vendor_orders; adds attachments, an inbound-audit table, and a
-- settings singleton.

-- Order-level flags for the DC round-trip (reuses vendor_orders otherwise).
alter table public.vendor_orders
  add column if not exists details_requested_at timestamptz,   -- DC "please send details" email sent
  add column if not exists details_received_at  timestamptz;   -- DC reply / acknowledgement received

-- Attachments (the DC's acknowledgement PDF + any manual uploads).
create table if not exists public.vendor_order_attachments (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.vendor_orders(id) on delete cascade,
  storage_path text not null,             -- vendor-order-attachments/{order_id}/{uuid}-{filename}
  filename    text,
  mime_type   text,
  byte_size   integer,
  source      text not null default 'manual',   -- 'manual' | 'dc_reply'
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists idx_vendor_order_attachments_order on public.vendor_order_attachments (order_id);

-- Inbound-email audit + idempotency (mirrors remittance_emails / leadgen_inbound_events).
create table if not exists public.clopay_sts_inbound_events (
  id              uuid primary key default gen_random_uuid(),
  resend_email_id text unique,            -- dedupe: one row per received email
  from_addr       text,
  subject         text,
  kind            text,                   -- 'orders' | 'dc_reply'
  outcome         text,                   -- 'ingested' | 'no_sts' | 'duplicate' | 'no_match' | 'error'
  detail          text,
  created_at      timestamptz not null default now()
);

-- Settings singleton: DC email + the auto-request toggle & new-only cutoff.
create table if not exists public.clopay_sts_settings (
  id                      boolean primary key default true check (id),
  auto_request_enabled    boolean not null default false,
  auto_request_enabled_at timestamptz,        -- cutoff: only orders first-seen at/after get auto-emailed
  dc_email                text not null default 'sandiegodc@clopay.com',
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users(id)
);
insert into public.clopay_sts_settings (id) values (true) on conflict (id) do nothing;

-- RLS: admin-all (service-role bypasses; these gate the browser client).
alter table public.vendor_order_attachments    enable row level security;
alter table public.clopay_sts_inbound_events    enable row level security;
alter table public.clopay_sts_settings          enable row level security;
drop policy if exists "admin_all_vendor_order_attachments" on public.vendor_order_attachments;
create policy "admin_all_vendor_order_attachments" on public.vendor_order_attachments for all using (public.is_admin());
drop policy if exists "admin_all_clopay_sts_inbound"        on public.clopay_sts_inbound_events;
create policy "admin_all_clopay_sts_inbound"        on public.clopay_sts_inbound_events for all using (public.is_admin());
drop policy if exists "admin_all_clopay_sts_settings"       on public.clopay_sts_settings;
create policy "admin_all_clopay_sts_settings"       on public.clopay_sts_settings       for all using (public.is_admin());

-- Private storage bucket for the acknowledgement PDFs (accessed via service role;
-- served to the browser through short-lived signed URLs).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vendor-order-attachments', 'vendor-order-attachments', false, 26214400,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "service_role_all_vendor_order_attachments" on storage.objects;
create policy "service_role_all_vendor_order_attachments"
  on storage.objects for all
  using (bucket_id = 'vendor-order-attachments' and (select auth.role()) = 'service_role');
