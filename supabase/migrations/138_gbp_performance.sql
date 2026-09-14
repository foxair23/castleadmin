-- Reputation Engine: Google Business Profile performance (PRD §5 item 6).
-- Daily impressions on Maps and Search, calls, website clicks, direction
-- requests, conversations and bookings, from the Business Profile Performance
-- API (same OAuth connection as the review sync; the API must be enabled once
-- in the Google Cloud project). A daily cron backfills the last 30 days, since
-- Google finalizes numbers a few days late.

create table if not exists public.gbp_daily_metrics (
  id           uuid primary key default gen_random_uuid(),
  location_id  text not null,                        -- "locations/…"
  date         date not null,
  metric       text not null,                        -- BUSINESS_IMPRESSIONS_DESKTOP_MAPS, CALL_CLICKS, …
  value        integer not null default 0,
  fetched_at   timestamptz not null default now(),
  unique (location_id, date, metric)
);
create index if not exists idx_gbp_daily_metrics_date on public.gbp_daily_metrics(location_id, date desc);

create table if not exists public.gbp_performance_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','done','failed')),
  days         integer,
  rows_written integer,
  error        text
);

do $$ declare t text; begin
  foreach t in array array['gbp_daily_metrics','gbp_performance_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all_%I on public.%I', t, t);
    execute format('create policy admin_all_%I on public.%I for all using (public.is_admin()) with check (public.is_admin())', t, t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
