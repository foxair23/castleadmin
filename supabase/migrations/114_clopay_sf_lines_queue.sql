-- Queue IPO line items for the extension to post to Service Fusion.
--
-- Service Fusion's API cannot modify an existing job — PUT /jobs returns 405, and the spec
-- documents no update endpoint at all. This is already known here: the remittance flow hit
-- the same wall and solved it by having the Chrome extension post through SF's web session
-- (lib/remittance/apply-queue.ts). Line items need the same treatment.
--
-- Creating a job still carries its lines through POST /jobs, which works. This queue is for
-- the far more common case: the job already exists, because the IPO arrives after autopilot
-- has booked it.
--
-- The app stays the source of truth — what to post, whether it is safe to, and the audit of
-- what happened. The extension is only the arm that clicks.
alter table public.vendor_orders
  add column if not exists sf_lines_status text;

comment on column public.vendor_orders.sf_lines_status is
  'IPO line items → SF job: queued (waiting for the extension), posted, failed, or skipped (e.g. the job already carries hand-entered lines). Null = never considered.';

create index if not exists idx_vendor_orders_sf_lines_queued
  on public.vendor_orders (vendor, sf_lines_status)
  where sf_lines_status = 'queued';
