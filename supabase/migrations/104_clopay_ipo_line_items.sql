-- Clopay IPO (Installer Purchase Order) line items — Phase 1.
--
-- The IPO PDF the crawler already stores carries the line-item detail of the work and what
-- Castle gets paid. This stores it RELATIONALLY (not as a blob) because Phase 2 maps
-- item_number onto Service Fusion's services catalog and writes these as SF job line items.
--
-- An order can accumulate several IPOs (a change order produces a revised IPO that restates
-- the whole order), so line items are kept per source document and the newest successfully
-- parsed IPO is flagged is_current; superseded rows are retained for history.

create table if not exists public.vendor_order_line_items (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.vendor_orders(id) on delete cascade,
  attachment_id       uuid references public.vendor_order_attachments(id) on delete cascade,
  source_document_ref text,                      -- Clopay documentId (attachment.external_ref)
  line_no             text,                      -- '1.1' as printed on the IPO
  quantity            numeric,
  item_number         text,                      -- 'FIR500' — Phase 2 joins the SF catalog on this
  description         text,
  line_fee            numeric(12,2) not null default 0,
  sort_order          integer not null default 0,
  is_current          boolean not null default true,  -- false once a newer IPO supersedes it
  created_at          timestamptz not null default now()
);

comment on table public.vendor_order_line_items is
  'Line items parsed from Clopay IPO PDFs (qty / item number / description / fee). Phase 2 turns these into Service Fusion job line items.';

create index if not exists idx_vendor_order_line_items_order
  on public.vendor_order_line_items (order_id, is_current);
create index if not exists idx_vendor_order_line_items_item
  on public.vendor_order_line_items (item_number);
-- Re-parsing a document replaces its rows rather than duplicating them.
create unique index if not exists uq_vendor_order_line_items_attachment_line
  on public.vendor_order_line_items (attachment_id, line_no)
  where attachment_id is not null;

alter table public.vendor_order_line_items enable row level security;

drop policy if exists admin_all_vendor_order_line_items on public.vendor_order_line_items;
create policy admin_all_vendor_order_line_items
  on public.vendor_order_line_items for all
  using (public.is_admin()) with check (public.is_admin());

-- Per-document parse state, so the backfill knows what is done and a bad parse is visible.
alter table public.vendor_order_attachments
  add column if not exists parsed_at        timestamptz,
  add column if not exists parse_status     text,          -- 'ok' | 'mismatch' | 'error' | 'not_ipo'
  add column if not exists parsed_total_fee numeric(12,2);

comment on column public.vendor_order_attachments.parse_status is
  'IPO parse outcome: ok (line fees sum to the stated TOTAL), mismatch (they do not — check the PDF), error, not_ipo';

-- Denormalized headline number for the HD Orders list (from the newest ok IPO).
alter table public.vendor_orders
  add column if not exists derived_total_fee numeric(12,2);

comment on column public.vendor_orders.derived_total_fee is
  'Clopay: TOTAL FEE from the most recent successfully parsed IPO document';
