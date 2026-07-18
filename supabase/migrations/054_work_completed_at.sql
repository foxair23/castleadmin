-- ============================================================
-- Migration 054: work_completed_at — revenue by WORK date
-- ============================================================
-- Problem: the Monthly Revenue chart bucketed by closed_at, but SF only stamps
-- closed_at (its completed_date) when a job reaches a closed status
-- (Invoiced/Paid) — not when the work was done. July 2026's big "Never
-- Invoiced" cleanup invoiced months of old completed work, dumping ~55% of
-- July's reported revenue ($60K of $110K) into the wrong month.
--
-- Fix: a real "when was the work completed" column.
--   Going forward : the hourly jobs sync stamps work_completed_at the FIRST
--                   time it observes a job in a completed-or-later status.
--   Backfill      : best available evidence, in priority order —
--     1. closed_at when sane (> 2000-01-01; SF stores epoch-1970 on some rows)
--     2. the EARLIEST completed-ish observation in sf_job_status_history
--        (the old analytics sync recorded status transitions May 10 – Jul 2,
--        2026 — exactly the distorted window), when earlier than (1)
--     3. start_date, for completed jobs with neither (completed after Jul 2,
--        never invoiced)
-- ============================================================

alter table public.sf_jobs
  add column if not exists work_completed_at timestamptz;

-- Pass 1 — sane closed_at (for long-closed jobs, invoice lag was small)
update public.sf_jobs
set    work_completed_at = closed_at
where  work_completed_at is null
  and  closed_at is not null
  and  closed_at > date '2000-01-01';

-- Pass 2 — an earlier "Completed" observation wins over the invoice stamp.
-- This is what corrects the July-invoiced backlog: those jobs were observed
-- at status Completed weeks before their closed_at was stamped at invoicing.
update public.sf_jobs j
set    work_completed_at = fc.first_seen
from (
  select sf_job_id, min(observed_at) as first_seen
  from   public.sf_job_status_history
  where  status ilike '%complet%'
     or  status ilike '%invoic%'
     or  status ilike '%paid%'
  group  by sf_job_id
) fc
where fc.sf_job_id = j.id
  and (j.work_completed_at is null or fc.first_seen < j.work_completed_at);

-- Pass 3 — completed-ish jobs with no other evidence: fall back to start_date
update public.sf_jobs
set    work_completed_at = start_date::timestamptz
where  work_completed_at is null
  and  start_date is not null
  and  (status ilike '%complet%' or status ilike '%invoic%' or status ilike '%paid%');

create index if not exists idx_sf_jobs_work_completed_at
  on public.sf_jobs (work_completed_at)
  where work_completed_at is not null;

-- Re-point the Monthly Revenue RPC at the work date. Same signature/shape —
-- only the bucketing column changes (closed_at kept as a safety fallback for
-- any row the passes above didn't reach).
create or replace function public.monthly_job_revenue()
returns table(ym text, revenue numeric)
language sql
stable
as $$
  select to_char(coalesce(work_completed_at, closed_at), 'YYYY-MM') as ym,
         sum(total)::numeric                                          as revenue
  from   public.sf_jobs
  where  is_deleted = false
    and  status not in ('Cancelled', 'Void', 'Voided')
    and  coalesce(work_completed_at, closed_at) >= date '2025-01-01'
    and  coalesce(work_completed_at, closed_at) <  date '2027-01-01'
  group  by 1
$$;

grant execute on function public.monthly_job_revenue() to authenticated, service_role;
