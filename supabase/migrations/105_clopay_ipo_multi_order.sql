-- A single Clopay IPO PDF can bundle SEVERAL complete IPOs — one page per order in a
-- multi-door job — and Clopay attaches the same bundle to every order in the group.
-- Two consequences this migration supports:
--
-- 1. One attachment now produces line items for MORE THAN ONE order, and each embedded
--    IPO restarts its line numbering at 1.1 — so the old unique key (attachment_id,
--    line_no) would collide. It becomes (attachment_id, order_id, line_no), and each row
--    records which order number its page belonged to.
--
-- 2. Some of those orders are REAL (real PO, real fee, physically reserved at the DC) but
--    never appear in the HD Program portal, so the crawler cannot see them — they were
--    invisible to us entirely. They are now recovered from the document; record_source
--    marks how a row got here so the UI can badge them and nobody mistakes them for
--    portal-tracked orders.

alter table public.vendor_order_line_items
  add column if not exists source_order_number text;

comment on column public.vendor_order_line_items.source_order_number is
  'The Order Number printed on the IPO page these lines came from — a bundled PDF contains several';

drop index if exists uq_vendor_order_line_items_attachment_line;
create unique index if not exists uq_vendor_order_line_items_attachment_order_line
  on public.vendor_order_line_items (attachment_id, order_id, line_no)
  where attachment_id is not null;

alter table public.vendor_orders
  add column if not exists record_source text not null default 'portal';

comment on column public.vendor_orders.record_source is
  'portal = seen in the HD Program portal by the crawler; ipo_document = recovered from a bundled IPO PDF (real order Clopay bills us for, but the portal never lists it)';

create index if not exists idx_vendor_orders_record_source
  on public.vendor_orders (vendor, record_source);
