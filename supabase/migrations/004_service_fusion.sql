-- ============================================================
-- v2: Service Fusion Integration
-- ============================================================

-- Fix: submitted_at must be nullable to support admin_unlock (upsert with null)
alter table public.week_submissions
  alter column submitted_at drop not null;

-- jobs: source tracking + SF fields
alter table public.jobs
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'service_fusion')),
  add column if not exists sf_job_id text,
  add column if not exists sf_status text
    check (sf_status is null or sf_status in ('assigned', 'completed')),
  add column if not exists sf_last_synced_at timestamptz;

-- Prevent the same SF job from being pulled twice for the same tech
create unique index if not exists jobs_tech_sf_job_unique
  on public.jobs (tech_id, sf_job_id)
  where sf_job_id is not null;

-- profiles: SF technician mapping
alter table public.profiles
  add column if not exists sf_technician_id text;

-- CRM sync log for troubleshooting
create table if not exists public.crm_sync_log (
  id uuid primary key default gen_random_uuid(),
  tech_id uuid references public.profiles(id) on delete cascade,
  triggered_at timestamptz not null default now(),
  week_start date not null,
  jobs_added int not null default 0,
  jobs_updated int not null default 0,
  success boolean not null,
  error_message text
);

-- OAuth token cache (server-side only, accessed via service role)
create table if not exists public.crm_tokens (
  provider text primary key,
  access_token text not null,
  expires_at timestamptz not null
);
