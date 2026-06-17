-- ============================================================
-- Migration 037: Google Reviews — Phase 1 tables
-- ============================================================

create table if not exists public.google_reviews (
  id                  uuid primary key default gen_random_uuid(),
  google_review_id    text not null unique,           -- last segment of GBP "name" field
  reviewer_name       text,
  star_rating         smallint not null check (star_rating between 1 and 5),
  comment             text,
  created_at_google   timestamptz not null,
  updated_at_google   timestamptz not null,
  reply_text          text,
  reply_updated_at    timestamptz,
  matched_customer_id text references public.sf_customers(id) on delete set null,
  matched_job_id      text references public.sf_jobs(id) on delete set null,
  match_confidence    text check (match_confidence in ('high', 'low', 'unmatched', 'manual')),
  match_status        text not null default 'pending_review'
                      check (match_status in ('auto', 'pending_review', 'confirmed', 'skipped', 'anonymous')),
  match_score         float,
  raw_payload         jsonb not null default '{}',
  ingested_at         timestamptz not null default now(),
  last_synced_at      timestamptz not null default now(),
  deleted_at          timestamptz,          -- soft-delete: reviewer removed their review
  location_id         text                  -- future multi-location support
);

create index if not exists idx_google_reviews_review_id    on public.google_reviews(google_review_id);
create index if not exists idx_google_reviews_created      on public.google_reviews(created_at_google desc);
create index if not exists idx_google_reviews_job          on public.google_reviews(matched_job_id);
create index if not exists idx_google_reviews_rating       on public.google_reviews(star_rating);
create index if not exists idx_google_reviews_status       on public.google_reviews(match_status);

-- ── Sync run log ─────────────────────────────────────────────
create table if not exists public.review_sync_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  reviews_seen    integer,
  reviews_new     integer,
  reviews_updated integer,
  errors_json     jsonb,
  status          text not null default 'running'
                  check (status in ('running', 'completed', 'failed'))
);

-- ── RLS ──────────────────────────────────────────────────────
alter table public.google_reviews    enable row level security;
alter table public.review_sync_runs  enable row level security;

drop policy if exists "admin_all_google_reviews"   on public.google_reviews;
drop policy if exists "admin_all_review_sync_runs" on public.review_sync_runs;

create policy "admin_all_google_reviews" on public.google_reviews
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

create policy "admin_all_review_sync_runs" on public.review_sync_runs
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

grant select, insert, update on public.google_reviews   to authenticated, service_role;
grant select, insert, update on public.review_sync_runs to authenticated, service_role;
