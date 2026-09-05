-- Track whether an SF job has had its IPO line items attached.
--
-- Line items are attached when a job is CREATED, but the IPO almost always arrives after
-- that: the order is crawled and autopilot books the job within 15 minutes, while the IPO
-- document is only captured when the extension's doc sync runs and parsed after that. So the
-- normal path is a job created with no lines and an IPO that shows up later — which is why
-- attaching has to happen on parse too, not only on create.
--
-- This marker is what stops the sweep re-reading and re-writing the same jobs on every run.
-- It lives on the order that owns the SF job (a group's primary), since one job covers the
-- whole group.
alter table public.vendor_orders
  add column if not exists sf_lines_synced_at timestamptz,
  add column if not exists sf_lines_sync_note text;

comment on column public.vendor_orders.sf_lines_synced_at is
  'When this order''s IPO line items were pushed to its SF job. Null = never attempted.';
comment on column public.vendor_orders.sf_lines_sync_note is
  'Outcome of the last attempt — how many lines were added, or why none were (e.g. the job already carries hand-entered services).';

create index if not exists idx_vendor_orders_sf_lines_pending
  on public.vendor_orders (vendor, sf_lines_synced_at)
  where sf_job_id is not null;
