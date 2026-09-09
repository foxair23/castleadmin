-- Genie self-scheduler: queue the appointment for the Chrome extension to write to SF.
--
-- The booking route has been trying PUT /jobs/{id} to set the date. Service Fusion's API
-- answers 405 — "this url can only handle GET, HEAD, OPTIONS" — so it has never once
-- worked: every Genie booking landed as "not synced, set the date manually". Payments and
-- IPO line items hit the same wall and are written through SF's web session by the
-- extension; the appointment gets the same treatment.
--
-- Same shape as sf_lines_status: the order is the source of truth, the extension is only
-- the arm that clicks, and what happened is recorded here for the office to see.
alter table public.vendor_orders
  add column if not exists sf_schedule_status     text,
  add column if not exists sf_schedule_job_number text,
  add column if not exists sf_schedule_sync_note  text,
  add column if not exists sf_schedule_synced_at  timestamptz;

comment on column public.vendor_orders.sf_schedule_status is
  'Appointment → SF job: queued (waiting for the extension), posted, or failed. Null = never booked online.';
comment on column public.vendor_orders.sf_schedule_job_number is
  'The SF job NUMBER the extension should open (SF global search wants the number, not the id). Set at booking from the created or matched job.';

create index if not exists idx_vendor_orders_sf_schedule_queued
  on public.vendor_orders (sf_schedule_status)
  where sf_schedule_status = 'queued';
