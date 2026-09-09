-- SF mirror: remember which soft-deleted jobs have been checked against SF one by one.
--
-- The weekly reconcile decides a job is gone when SF's paginated list stops returning it.
-- That list drops records at page boundaries, and a job that sits at a boundary is dropped
-- every week — so it is stamped, then soft-deleted, then never seen again to recover, while
-- SF still has it (job 1020257932: invoiced, $1,895 due, hidden from every tab since June).
--
-- The daily sync now asks SF directly about soft-deleted jobs, a batch at a time, and
-- revives the ones SF still has. This column marks the ones already asked about, so the
-- truly deleted are not re-checked every day.
alter table public.sf_jobs
  add column if not exists sf_deleted_verified_at timestamptz;

create index if not exists idx_sf_jobs_deleted_unverified
  on public.sf_jobs (closed_at desc)
  where is_deleted = true and sf_deleted_verified_at is null;
