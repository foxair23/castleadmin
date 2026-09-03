-- Weekly Clopay DC report — "Fully Received and Reserved".
--
-- Every Monday the San Diego DC emails the orders physically sitting there waiting to be
-- picked up. The report carries one fact that exists NOWHERE else in the platform: the
-- RESERVED DATE, i.e. how long product has been parked at the DC. On the 31-Aug file, 28 of
-- 73 orders had been sitting over 30 days and the two oldest were at 222 and 203 days —
-- product Castle has been paid to install, aging in a warehouse, with no signal anywhere.
--
-- The report does NOT own status. vendor_orders.status stays the crawler's: the portal is
-- live, this file is a weekly snapshot, and comparing the two found drift in both directions
-- (7 behind, 16 ahead), so letting a Monday file write status would sometimes move orders
-- backwards mid-week. The report contributes aging, not state.

-- One row per Monday file. raw_text is kept so a parser fix can re-run without the PDF.
create table if not exists public.clopay_dc_reports (
  id              uuid primary key default gen_random_uuid(),
  report_date     date not null,
  received_at     timestamptz not null default now(),
  source          text not null default 'email',   -- 'email' | 'manual'
  resend_email_id text,                            -- inbound idempotency (mirrors remittance_emails)
  storage_path    text,                            -- the PDF itself, for audit
  raw_text        text,
  row_count       integer,
  parse_ok        boolean not null default false
);
create unique index if not exists uq_clopay_dc_reports_date on public.clopay_dc_reports (report_date);
create unique index if not exists uq_clopay_dc_reports_email on public.clopay_dc_reports (resend_email_id) where resend_email_id is not null;

-- What that file said, verbatim — never edited, so a bad parse is always diagnosable.
create table if not exists public.clopay_dc_report_rows (
  id            uuid primary key default gen_random_uuid(),
  report_id     uuid not null references public.clopay_dc_reports(id) on delete cascade,
  order_no      text not null,
  po            text,                              -- null for Castle-direct orders
  kind          text not null default 'HD',        -- 'HD' | 'CASTLE_DIRECT'
  entered_date  date,
  reserved_date date,
  order_id      uuid references public.vendor_orders(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (report_id, order_no)
);
create index if not exists idx_clopay_dc_report_rows_order on public.clopay_dc_report_rows (order_id);

-- The worklist. Keyed by PO because that is the unit of work: a customer can have one PO
-- arrive at the DC while another has not. Separate from vendor_orders because Castle-direct
-- POs have no order row at all, and because a dismissal must outlive any single report — a
-- PO stays on the weekly file for as long as it physically sits at the DC, sometimes because
-- the customer asked to wait. Once scheduled_at is set the PO never surfaces again.
create table if not exists public.clopay_dc_po_state (
  po_key             text primary key,             -- the PO, or 'ORDER:'||order_no when there is none
  order_no           text not null,
  po                 text,
  kind               text not null default 'HD',
  first_seen_report  date not null,
  last_seen_report   date not null,
  entered_date       date,
  reserved_date      date,
  order_id           uuid references public.vendor_orders(id) on delete set null,
  scheduled_at       timestamptz,
  scheduled_by       text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_clopay_dc_po_state_open on public.clopay_dc_po_state (scheduled_at, reserved_date);

comment on table public.clopay_dc_po_state is
  'One row per PO seen on the weekly Clopay DC report. scheduled_at is a permanent dismissal — the PO recurs on every report until it physically leaves the DC, and must not resurface once handled.';

-- Denormalized onto the order for the HD Orders list (same pattern as derived_total_fee).
alter table public.vendor_orders
  add column if not exists dc_reserved_at  date,
  add column if not exists dc_last_seen_at date;

comment on column public.vendor_orders.dc_reserved_at is
  'Clopay: date the product was reserved at the DC, from the newest weekly DC report naming this order. The aging clock for "sitting at the DC".';

alter table public.clopay_dc_reports     enable row level security;
alter table public.clopay_dc_report_rows enable row level security;
alter table public.clopay_dc_po_state    enable row level security;

drop policy if exists admin_all_clopay_dc_reports on public.clopay_dc_reports;
create policy admin_all_clopay_dc_reports on public.clopay_dc_reports for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all_clopay_dc_report_rows on public.clopay_dc_report_rows;
create policy admin_all_clopay_dc_report_rows on public.clopay_dc_report_rows for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all_clopay_dc_po_state on public.clopay_dc_po_state;
create policy admin_all_clopay_dc_po_state on public.clopay_dc_po_state for all
  using (public.is_admin()) with check (public.is_admin());
