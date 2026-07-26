-- Commission upsell tracking — job "before" baseline.
--
-- The Upsell tab compares a job's total BEFORE the tech went out (the amount as
-- it stood the morning of the service day) to its final commission revenue,
-- to surface how much each tech upsells.
--
-- We don't keep job-total history anywhere else (the SF sync overwrites
-- sf_jobs.total each run), so this table captures the baseline once and never
-- lets it change. A daily 7am-PT cron stamps baseline_total for every job whose
-- service day is that day. Kept in its own table so the SF mirror sync can't
-- clobber it.
--
-- Notes:
--   • A captured 0 is a REAL $0 baseline (job unpriced/lead at 7am) → the whole
--     final total counts as upsell. "No baseline captured" is the ABSENCE of a
--     row (job predates this feature, or booked same-day after 7am) → shown as
--     "—" and excluded from totals.
--   • baseline is captured for ALL jobs that day, not just commission ones — a
--     job's commission claim often appears after the service day, and we'd
--     otherwise have no baseline to compare against.
create table if not exists public.commission_job_baseline (
  sf_job_id      text primary key references public.sf_jobs(id) on delete cascade,
  baseline_total numeric(12,2) not null default 0,
  captured_at    timestamptz not null default now()
);

alter table public.commission_job_baseline enable row level security;

-- Admin-only (an internal derived figure; techs never see it).
drop policy if exists "admin_all_commission_job_baseline" on public.commission_job_baseline;
create policy "admin_all_commission_job_baseline" on public.commission_job_baseline
  for all using (public.is_admin());
