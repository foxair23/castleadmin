-- Replace per-job unique constraint with per-visit (tech, job, date).
-- Visits have no ID in the SF API, so (tech_id, sf_job_id, work_date) is
-- the finest grain deduplication key available.
drop index if exists jobs_tech_sf_job_unique;

create unique index if not exists jobs_tech_sf_job_date_unique
  on public.jobs (tech_id, sf_job_id, work_date)
  where sf_job_id is not null;

-- Store visit position so the UI can show "Visit 2 of 3"
alter table public.jobs
  add column if not exists sf_visit_index integer,
  add column if not exists sf_visit_total integer;
