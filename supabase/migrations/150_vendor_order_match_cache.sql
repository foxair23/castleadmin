-- A cache of the SF job each vendor order matches, so other screens can JOIN instead of
-- re-running the matcher.
--
-- Only human DECISIONS were ever stored (sf_job_id on a manual link or a job we created).
-- Every other row on HD Orders — the PO, name, email and phone matches, which are most of
-- them — was computed at render and thrown away, so Action Items, starting from an SF job,
-- had nothing to join to.
--
-- This is a cache and is treated as one: a stored decision always wins over it, it is never
-- trusted when stale, and nothing that WRITES into Service Fusion reads it — those keep
-- resolving live, because a wrong match there posts money onto a stranger's job.
alter table public.vendor_orders
  add column if not exists sf_match_job_id text,
  add column if not exists sf_match_job_number text,
  add column if not exists sf_match_method text,
  add column if not exists sf_matched_at timestamptz;

comment on column public.vendor_orders.sf_match_job_id is
  'CACHE of the matcher''s answer (PO / name / email / phone). Refreshed on a schedule; sf_job_id and sf_created_job_number outrank it. Never used to authorise a write into Service Fusion.';

-- The join Action Items does: given SF job ids, which orders match them?
create index if not exists idx_vendor_orders_sf_match_job_id
  on public.vendor_orders (sf_match_job_id)
  where sf_match_job_id is not null;
