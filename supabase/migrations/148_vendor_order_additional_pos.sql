-- Clopay reissues POs. A change order cancels the PO on the portal row and a NEW IPO document
-- arrives carrying a new PO number — while the portal row keeps showing the dead one, because
-- Clopay never removes it. The office then cannot match the job: the SF job carries the new PO
-- and we only ever knew the old one.
--
-- Every PO an IPO names for an order is kept here, so the matcher can try all of them.
-- The portal row's own number (external_id) stays the row's identity and is never rewritten.
alter table public.vendor_orders
  add column if not exists additional_pos text[] not null default '{}';

comment on column public.vendor_orders.additional_pos is
  'Extra PO numbers seen on this order''s IPO documents (Clopay reissues a PO on a change order). Matched against sf_jobs.po_number alongside external_id.';

create index if not exists idx_vendor_orders_additional_pos
  on public.vendor_orders using gin (additional_pos);
