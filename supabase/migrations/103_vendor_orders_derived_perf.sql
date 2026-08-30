-- HD Orders perf phase 2 (run BEFORE/with the app deploy that writes these columns).
--
-- 1. Clopay display fields derived from `raw` become stored columns, computed at ingest
--    (lib/vendor-orders/clopay-derived.ts) — so the HD Orders list query stops selecting
--    every order's multi-KB raw jsonb per page view. Backfilled here for existing rows.
-- 2. The list query's ordering gets a supporting index (vendor, first_seen_at desc).
-- 3. vendor_order_events: the reader orders by `created_at`, but migration 084 created
--    the timestamp column as `at`. Ensure created_at exists (backfilled from `at` when
--    present) and give the last-status-change lookup a covering index.

alter table public.vendor_orders
  add column if not exists derived_order_date date,
  add column if not exists derived_last_activity_at timestamptz,
  add column if not exists has_detail boolean;

comment on column public.vendor_orders.derived_order_date is
  'Clopay: the "Order Received" milestone date from raw.summary (ingest-computed; migration 103 backfilled)';
comment on column public.vendor_orders.derived_last_activity_at is
  'Clopay: most recent timestamp in raw.summary/raw.notes (ingest-computed)';
comment on column public.vendor_orders.has_detail is
  'raw carries drawer-worthy detail (summary/summary_text/documents/notes) — lets the list query skip raw';

create index if not exists idx_vendor_orders_vendor_first_seen
  on public.vendor_orders (vendor, first_seen_at desc);

-- ── vendor_order_events.created_at ───────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'vendor_order_events' and column_name = 'created_at'
  ) then
    alter table public.vendor_order_events add column created_at timestamptz not null default now();
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'vendor_order_events' and column_name = 'at'
    ) then
      execute 'update public.vendor_order_events set created_at = at';
    end if;
  end if;
end $$;

create index if not exists idx_vendor_order_events_status_change
  on public.vendor_order_events (order_id, event_type, created_at desc);

-- ── Backfill the derived columns for existing clopay_hd rows ─────────────────
-- Mirrors parseClopayTs(): strip a trailing timezone abbreviation, accept
-- "MM/DD/YYYY HH:MI AM" or "MM/DD/YYYY", reject "Not Applicable"/unparseable.
create or replace function pg_temp.parse_clopay_ts(s text) returns timestamptz
language plpgsql immutable as $fn$
declare
  t text;
begin
  if s is null then return null; end if;
  t := btrim(regexp_replace(s, '\s+(CST|CDT|EST|EDT|MST|MDT|PST|PDT|UTC|GMT)\M.*$', '', 'i'));
  if t = '' or t ~* 'not applicable' then return null; end if;
  begin
    if t ~ '^\d{1,2}/\d{1,2}/\d{4}\s+\d{1,2}:\d{2}\s*(AM|PM)$' then
      return to_timestamp(t, 'MM/DD/YYYY HH12:MI AM');
    elsif t ~ '^\d{1,2}/\d{1,2}/\d{4}$' then
      return to_timestamp(t, 'MM/DD/YYYY');
    else
      return t::timestamptz;
    end if;
  exception when others then
    return null;
  end;
end
$fn$;

with sub as (
  select
    v.id,
    (
      select pg_temp.parse_clopay_ts(coalesce(m->>'completed', m->>'posted', m->>'date'))
      from jsonb_array_elements(
        case when jsonb_typeof(v.raw->'summary') = 'array' then v.raw->'summary' else '[]'::jsonb end
      ) m
      where m->>'label' ~* 'order received'
      limit 1
    )::date as order_date,
    greatest(
      (
        select max(pg_temp.parse_clopay_ts(coalesce(m->>'completed', m->>'posted')))
        from jsonb_array_elements(
          case when jsonb_typeof(v.raw->'summary') = 'array' then v.raw->'summary' else '[]'::jsonb end
        ) m
      ),
      (
        select max(pg_temp.parse_clopay_ts(n->>'timestamp'))
        from jsonb_array_elements(
          case when jsonb_typeof(v.raw->'notes') = 'array' then v.raw->'notes' else '[]'::jsonb end
        ) n
      )
    ) as last_activity,
    (
      (jsonb_typeof(v.raw->'summary') = 'array' and jsonb_array_length(v.raw->'summary') > 0)
      or length(coalesce(v.raw->>'summary_text', '')) > 0
      or (jsonb_typeof(v.raw->'documents') = 'array' and jsonb_array_length(v.raw->'documents') > 0)
      or (jsonb_typeof(v.raw->'notes') = 'array' and jsonb_array_length(v.raw->'notes') > 0)
    ) as has_detail
  from public.vendor_orders v
  where v.vendor = 'clopay_hd'
)
update public.vendor_orders v
set derived_order_date = sub.order_date,
    derived_last_activity_at = sub.last_activity,
    has_detail = sub.has_detail
from sub
where v.id = sub.id;
