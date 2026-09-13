-- Reputation Engine, Phase 3 (PRD castle-prd-reputation.md §8): Map Pack rank
-- tracking. A monitored list of keyword × place (city, ZIP or a dropped pin),
-- scanned weekly from the place's center with an optional mini-grid; live
-- "check now" queries saved alongside; the top 20 businesses per point for the
-- competitor table; and the office-maintained list of area pages on the website.
--
-- Data comes from the DataForSEO Google Maps SERP API (DATAFORSEO_LOGIN /
-- DATAFORSEO_PASSWORD). Nothing is scanned, and nothing costs money, until the
-- office adds monitors. updated_at columns are maintained by application code.

-- ── reputation_settings: rank knobs ──────────────────────────────────────────
alter table public.reputation_settings add column if not exists rank_scans_enabled       boolean not null default true;
-- Case-insensitive text that identifies Castle's own listing in results (matched
-- against the business title). Keep it short so a renamed profile still matches.
alter table public.reputation_settings add column if not exists rank_business_match      text not null default 'castle garage';
-- Weekly ceiling on provider requests, so a large monitored list cannot run away.
alter table public.reputation_settings add column if not exists rank_weekly_request_cap  int not null default 2000;
-- Starting keywords offered when adding a place. Free text, expected to change.
alter table public.reputation_settings add column if not exists rank_default_keywords    text[] not null default
  '{"garage door repair","garage door installation","garage door opener repair","garage door spring repair","gate repair","garage door company"}';

-- ── rank_places: a city, ZIP, or pin the office cares about ──────────────────
create table if not exists public.rank_places (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  kind        text not null default 'city' check (kind in ('city','zip','pin')),
  lat         double precision not null,
  lng         double precision not null,
  zips        text[] not null default '{}',          -- ZIPs that count as "here" for jobs and reviews
  is_active   boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── rank_monitors: keyword × place, scanned weekly ───────────────────────────
create table if not exists public.rank_monitors (
  id             uuid primary key default gen_random_uuid(),
  location_id    text,                               -- future multi-location (§7)
  place_id       uuid not null references public.rank_places(id) on delete cascade,
  keyword        text not null,
  grid_size      int not null default 3 check (grid_size in (1,3,5,7,9)),
  spacing_miles  numeric(4,2) not null default 1.0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (place_id, keyword)
);
create index if not exists idx_rank_monitors_active on public.rank_monitors(is_active);

-- ── rank_scans: one run of one keyword from one center ───────────────────────
create table if not exists public.rank_scans (
  id             uuid primary key default gen_random_uuid(),
  monitor_id     uuid references public.rank_monitors(id) on delete set null,
  place_id       uuid references public.rank_places(id) on delete set null,
  keyword        text not null,
  center_lat     double precision not null,
  center_lng     double precision not null,
  grid_size      int not null default 1,
  spacing_miles  numeric(4,2) not null default 1.0,
  source         text not null default 'live' check (source in ('weekly','live')),
  status         text not null default 'running' check (status in ('running','done','failed')),
  week_key       text,                               -- Monday (PT) of the scan week, for week-over-week
  requests       int not null default 0,
  cost_usd       numeric(8,4),
  our_rank_avg   numeric(5,2),                       -- over points where we appear
  found_share    numeric(4,3),                       -- points where we appear / points
  top3_share     numeric(4,3),
  error          text,
  run_at         timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists idx_rank_scans_monitor on public.rank_scans(monitor_id, run_at desc);
create index if not exists idx_rank_scans_week on public.rank_scans(week_key, keyword);

-- ── rank_scan_points: one grid point of one scan ─────────────────────────────
create table if not exists public.rank_scan_points (
  id        uuid primary key default gen_random_uuid(),
  scan_id   uuid not null references public.rank_scans(id) on delete cascade,
  row       int not null,
  col       int not null,
  lat       double precision not null,
  lng       double precision not null,
  our_rank  int,                                     -- 1–20, null = not in the top 20
  results   jsonb not null default '[]'::jsonb,      -- [{rank, title, rating, reviews, place_id, cid, address, is_us}]
  error     text
);
create index if not exists idx_rank_scan_points_scan on public.rank_scan_points(scan_id);

-- ── area_pages: the website's neighborhood pages, maintained by the office ───
create table if not exists public.area_pages (
  id          uuid primary key default gen_random_uuid(),
  place_id    uuid not null references public.rank_places(id) on delete cascade,
  url         text not null,
  notes       text,
  page_updated_at date,                              -- when the page content was last refreshed
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (place_id)
);

-- ── Starter places (service area from the website), inactive until used ──────
-- Coordinates are city centers; the office can adjust or drop a pin instead.
insert into public.rank_places (name, kind, lat, lng, zips, sort) values
  ('Escondido',       'city', 33.1192, -117.0864, '{92025,92026,92027,92029}', 1),
  ('San Marcos',      'city', 33.1434, -117.1661, '{92069,92078}', 2),
  ('Vista',           'city', 33.2000, -117.2425, '{92081,92083,92084}', 3),
  ('Oceanside',       'city', 33.1959, -117.3795, '{92054,92056,92057,92058}', 4),
  ('Carlsbad',        'city', 33.1581, -117.3506, '{92008,92009,92010,92011}', 5),
  ('Encinitas',       'city', 33.0370, -117.2920, '{92024,92007}', 6),
  ('Poway',           'city', 32.9628, -117.0359, '{92064}', 7),
  ('Rancho Bernardo', 'city', 33.0217, -117.0770, '{92127,92128}', 8),
  ('San Diego',       'city', 32.7157, -117.1611, '{92101,92103,92104,92105,92108,92110,92111,92115,92116,92117,92120,92123,92124}', 9),
  ('Chula Vista',     'city', 32.6401, -117.0842, '{91910,91911,91913,91914,91915}', 10),
  ('Fallbrook',       'city', 33.3764, -117.2511, '{92028}', 11),
  ('Bonsall',         'city', 33.2889, -117.2256, '{92003}', 12),
  ('Temecula',        'city', 33.4936, -117.1484, '{92590,92591,92592}', 13),
  ('Murrieta',        'city', 33.5539, -117.2139, '{92562,92563}', 14),
  ('Corona',          'city', 33.8753, -117.5664, '{92879,92880,92881,92882,92883}', 15)
on conflict (name) do nothing;

-- ── RLS + grants ─────────────────────────────────────────────────────────────
do $$ declare t text; begin
  foreach t in array array['rank_places','rank_monitors','rank_scans','rank_scan_points','area_pages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all_%I on public.%I', t, t);
    execute format('create policy admin_all_%I on public.%I for all using (public.is_admin()) with check (public.is_admin())', t, t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
