-- Multi-door jobs: one house = one job = one SF job.
--
-- A customer with several garage doors gets one Clopay order per door — each with its own
-- PO and DC order number — all bundled into a single IPO PDF (one page per door). Service
-- Fusion already models this the right way: ONE job carrying every PO, because it's one
-- house, one crew visit, one invoice.
--
-- parent_order_id links the doors of a bundle to a single primary order. The primary is
-- preferred to be a record_source='portal' row (only those carry status, notes, documents
-- and schedule); recovered ipo_document rows hang off it. Two consequences:
--   * the HD Orders list shows one row per house, with the group's total money;
--   * autopilot only ever considers a primary, so one house can't spawn several SF jobs.

alter table public.vendor_orders
  add column if not exists parent_order_id uuid references public.vendor_orders(id) on delete set null;

comment on column public.vendor_orders.parent_order_id is
  'Multi-door job grouping: the doors bundled in one IPO point at the group primary. Null = this row IS the primary (or is not part of a group). One group = one SF job.';

create index if not exists idx_vendor_orders_parent
  on public.vendor_orders (parent_order_id);
