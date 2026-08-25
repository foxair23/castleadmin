-- Log of vendor-portal scrape runs, so the HD Orders page can show when the
-- Genie site was last read and what kind of scrape it was — a health readout.
-- The order count is the key signal: a comprehensive crawl pulls the whole list
-- (~200+); a sudden small count means the scraper (e.g. pagination) broke.

create table if not exists public.vendor_scrape_runs (
  id             uuid primary key default gen_random_uuid(),
  vendor         text not null,                 -- 'genie_thd' | future vendors
  kind           text not null,                 -- 'list' | 'detail'
  mode           text,                          -- 'full' | 'incremental' | 'manual'
  received       integer not null default 0,    -- orders in this scrape (completeness signal)
  inserted       integer not null default 0,
  updated        integer not null default 0,
  status_changes integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists idx_vendor_scrape_runs_vendor_at on public.vendor_scrape_runs (vendor, created_at desc);

alter table public.vendor_scrape_runs enable row level security;
drop policy if exists "admin_all_vendor_scrape_runs" on public.vendor_scrape_runs;
create policy "admin_all_vendor_scrape_runs" on public.vendor_scrape_runs for all using (public.is_admin());
