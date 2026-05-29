-- ============================================================
-- Castle Garage Doors & Gates — Analytics Phase 1
-- ============================================================

-- ------------------------------------------------------------
-- Lookup / reference tables (no RLS — readable by all authed users)
-- ------------------------------------------------------------

create table if not exists public.sf_job_statuses_ref (
  id          text primary key,
  name        text not null,
  category    text,
  is_closed   boolean not null default false,
  synced_at   timestamptz not null default now()
);

create table if not exists public.sf_job_categories_ref (
  id        text primary key,
  name      text not null,
  synced_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Cache tables
-- ------------------------------------------------------------

create table if not exists public.sf_customers_cache (
  id            text primary key,
  created_at_sf timestamptz,
  lead_source   text,
  zip           text,
  synced_at     timestamptz not null default now()
);

create table if not exists public.sf_jobs_cache (
  id                         text primary key,
  customer_id                text,
  category_id                text,
  category_name              text,
  status_id                  text,
  status_name                text,
  status_category            text,
  is_closed                  boolean not null default false,
  created_at_sf              timestamptz,
  scheduled_at               timestamptz,
  original_scheduled_at      timestamptz,
  completed_at               timestamptz,
  total_amount               numeric(10,2),
  lead_source                text,
  zip                        text,
  multi_visit                boolean not null default false,
  visit_count                int not null default 1,
  reschedule_count           int not null default 0,
  parts_reschedule_count     int not null default 0,
  schedule_history_truncated boolean not null default false,
  is_callback                boolean not null default false,
  callback_source            text,
  synced_at                  timestamptz not null default now()
);

create table if not exists public.sf_job_techs_cache (
  id         uuid primary key default gen_random_uuid(),
  sf_job_id  text not null,
  sf_tech_id text not null,
  synced_at  timestamptz not null default now(),
  unique (sf_job_id, sf_tech_id)
);

-- ------------------------------------------------------------
-- History tables
-- ------------------------------------------------------------

create table if not exists public.sf_job_schedule_history (
  id                       uuid primary key default gen_random_uuid(),
  sf_job_id                text not null,
  scheduled_at             timestamptz not null,
  previous_scheduled_at    timestamptz,
  observed_at              timestamptz not null,
  change_type              text not null,
  reschedule_reason        text,
  reschedule_reason_source text,
  job_status_at_change     text,
  created_at               timestamptz not null default now()
);

create table if not exists public.sf_job_status_history (
  id              uuid primary key default gen_random_uuid(),
  sf_job_id       text not null,
  status          text not null,
  status_category text,
  previous_status text,
  observed_at     timestamptz not null,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Estimates & invoices
-- ------------------------------------------------------------

create table if not exists public.sf_estimates_cache (
  id               text primary key,
  customer_id      text,
  assigned_tech_id text,
  status           text,
  created_at_sf    timestamptz,
  accepted_at      timestamptz,
  declined_at      timestamptz,
  total            numeric(10,2),
  synced_at        timestamptz not null default now()
);

create table if not exists public.sf_invoices_cache (
  id          text primary key,
  job_id      text,
  customer_id text,
  issued_at   timestamptz,
  due_at      timestamptz,
  total       numeric(10,2),
  balance_due numeric(10,2),
  paid_at     timestamptz,
  synced_at   timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Dashboard annotations
-- ------------------------------------------------------------

create table if not exists public.dashboard_annotations (
  id          uuid primary key default gen_random_uuid(),
  occurred_on date not null,
  title       text not null,
  note        text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Sync observability log
-- ------------------------------------------------------------

create table if not exists public.analytics_sync_log (
  id             uuid primary key default gen_random_uuid(),
  sync_type      text not null,
  entity         text not null,
  status         text not null,
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  records_synced int not null default 0,
  records_total  int,
  last_page      int,
  error_message  text,
  meta           jsonb
);

-- ============================================================
-- Indexes
-- ============================================================

-- sf_jobs_cache
create index if not exists idx_sf_jobs_cache_customer  on public.sf_jobs_cache(customer_id);
create index if not exists idx_sf_jobs_cache_status    on public.sf_jobs_cache(status_name);
create index if not exists idx_sf_jobs_cache_scheduled on public.sf_jobs_cache(scheduled_at);
create index if not exists idx_sf_jobs_cache_completed on public.sf_jobs_cache(completed_at);
create index if not exists idx_sf_jobs_cache_synced    on public.sf_jobs_cache(synced_at);
create index if not exists idx_sf_jobs_cache_zip       on public.sf_jobs_cache(zip);

-- sf_job_techs_cache
create index if not exists idx_sf_job_techs_job  on public.sf_job_techs_cache(sf_job_id);
create index if not exists idx_sf_job_techs_tech on public.sf_job_techs_cache(sf_tech_id);

-- sf_job_schedule_history
create index if not exists idx_sf_sched_hist_job      on public.sf_job_schedule_history(sf_job_id);
create index if not exists idx_sf_sched_hist_observed on public.sf_job_schedule_history(observed_at);

-- sf_job_status_history
create index if not exists idx_sf_status_hist_job      on public.sf_job_status_history(sf_job_id);
create index if not exists idx_sf_status_hist_observed on public.sf_job_status_history(observed_at);

-- sf_invoices_cache
create index if not exists idx_sf_invoices_job    on public.sf_invoices_cache(job_id);
create index if not exists idx_sf_invoices_issued on public.sf_invoices_cache(issued_at);

-- sf_estimates_cache
create index if not exists idx_sf_estimates_tech   on public.sf_estimates_cache(assigned_tech_id);
create index if not exists idx_sf_estimates_status on public.sf_estimates_cache(status);

-- analytics_sync_log
create index if not exists idx_sync_log_type_status on public.analytics_sync_log(sync_type, status);
create index if not exists idx_sync_log_started     on public.analytics_sync_log(started_at desc);

-- ============================================================
-- Row-Level Security
-- ============================================================

-- Cache / history / annotation / log tables get RLS.
-- Ref tables (sf_job_statuses_ref, sf_job_categories_ref) are skipped
-- per spec — they are read-only reference data for all authenticated users.

alter table public.sf_customers_cache       enable row level security;
alter table public.sf_jobs_cache            enable row level security;
alter table public.sf_job_techs_cache       enable row level security;
alter table public.sf_job_schedule_history  enable row level security;
alter table public.sf_job_status_history    enable row level security;
alter table public.sf_estimates_cache       enable row level security;
alter table public.sf_invoices_cache        enable row level security;
alter table public.dashboard_annotations    enable row level security;
alter table public.analytics_sync_log       enable row level security;

-- sf_customers_cache — admin only
drop policy if exists "admin_all_sf_customers_cache" on public.sf_customers_cache;
create policy "admin_all_sf_customers_cache" on public.sf_customers_cache
  for all using (public.is_admin());

-- sf_jobs_cache — admin only
drop policy if exists "admin_all_sf_jobs_cache" on public.sf_jobs_cache;
create policy "admin_all_sf_jobs_cache" on public.sf_jobs_cache
  for all using (public.is_admin());

-- sf_job_techs_cache — admin only
drop policy if exists "admin_all_sf_job_techs_cache" on public.sf_job_techs_cache;
create policy "admin_all_sf_job_techs_cache" on public.sf_job_techs_cache
  for all using (public.is_admin());

-- sf_job_schedule_history — admin only
drop policy if exists "admin_all_sf_job_schedule_history" on public.sf_job_schedule_history;
create policy "admin_all_sf_job_schedule_history" on public.sf_job_schedule_history
  for all using (public.is_admin());

-- sf_job_status_history — admin only
drop policy if exists "admin_all_sf_job_status_history" on public.sf_job_status_history;
create policy "admin_all_sf_job_status_history" on public.sf_job_status_history
  for all using (public.is_admin());

-- sf_estimates_cache — admin only
drop policy if exists "admin_all_sf_estimates_cache" on public.sf_estimates_cache;
create policy "admin_all_sf_estimates_cache" on public.sf_estimates_cache
  for all using (public.is_admin());

-- sf_invoices_cache — admin only
drop policy if exists "admin_all_sf_invoices_cache" on public.sf_invoices_cache;
create policy "admin_all_sf_invoices_cache" on public.sf_invoices_cache
  for all using (public.is_admin());

-- dashboard_annotations — admins full access; techs may select
drop policy if exists "admin_all_dashboard_annotations" on public.dashboard_annotations;
create policy "admin_all_dashboard_annotations" on public.dashboard_annotations
  for all using (public.is_admin());

drop policy if exists "tech_select_dashboard_annotations" on public.dashboard_annotations;
create policy "tech_select_dashboard_annotations" on public.dashboard_annotations
  for select using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'technician' and is_active = true
    )
  );

-- analytics_sync_log — admin only
drop policy if exists "admin_all_analytics_sync_log" on public.analytics_sync_log;
create policy "admin_all_analytics_sync_log" on public.analytics_sync_log
  for all using (public.is_admin());
