-- ============================================================
-- Migration 036: monthly_job_revenue() RPC
-- ============================================================
-- The dashboard monthly revenue chart sums job totals bucketed by
-- the month of sf_jobs.closed_at — i.e. revenue is recognized when
-- the job is completed. Doing the aggregation in SQL avoids
-- PostgREST's 1000-row response cap, which silently truncated the
-- previous JS approach.
--
-- Note on basis: Service Fusion's own "Sales Revenue" report buckets
-- by start_date (scheduled/sale date). We intentionally use closed_at
-- instead because that is when the work is done and revenue can be
-- recognized, so dashboard month totals will differ from the SF report
-- for jobs that span a month/year boundary. Both pull the same metric
-- (sf_jobs.total); only the bucketing date differs.
--
-- Definition:
--   metric : sum(sf_jobs.total)            -- job total, incl. tax
--   bucket : month of closed_at            -- revenue recognized on completion
--   filter : not deleted, status not in (Cancelled, Void, Voided)
-- ============================================================

create or replace function public.monthly_job_revenue()
returns table(ym text, revenue numeric)
language sql
stable
as $$
  select to_char(closed_at, 'YYYY-MM')           as ym,
         sum(total)::numeric                       as revenue
  from   public.sf_jobs
  where  is_deleted = false
    and  status not in ('Cancelled', 'Void', 'Voided')
    and  closed_at >= date '2025-01-01'
    and  closed_at <  date '2027-01-01'
  group  by 1
$$;

grant execute on function public.monthly_job_revenue() to authenticated, service_role;
