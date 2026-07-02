-- Marketing "last serviced" filter correctness.
--
-- BUG: the marketing filter matched customers on sf_customers.last_serviced_date,
-- which the mirror stores verbatim from Service Fusion's customer record and goes
-- STALE. Meanwhile the UI/CSV show the customer's real most-recent service
-- (max sf_jobs.closed_at). So a customer serviced recently could still match an
-- OLD date range (e.g. 1970 → 2025-02) and get marketed to right after we did
-- work for them.
--
-- FIX: match on the job-derived last service date — the same source the UI shows.
-- This function returns matching customer ids + their job-derived last service,
-- ordered most-recent-first (matching the display). Category filtering stays in
-- the app layer (intersected), so it isn't a parameter here.
--
-- Date extraction uses `at time zone 'UTC'` so the calendar date matches the
-- app's `closed_at.slice(0,10)` (PostgREST serializes timestamptz as UTC).

create or replace function public.marketing_customer_ids(
  p_date_from date,
  p_date_to date,
  p_none boolean,
  p_sources text[],
  p_payment_outstanding boolean
)
returns table(id text, last_service date)
language sql
stable
as $$
  with last_service as (
    select customer_id,
           max((closed_at at time zone 'UTC')::date) as lsd
    from public.sf_jobs
    where coalesce(is_deleted, false) = false
      and closed_at is not null
      and customer_id is not null
    group by customer_id
  )
  select c.id, ls.lsd
  from public.sf_customers c
  left join last_service ls on ls.customer_id = c.id
  where coalesce(c.is_deleted, false) = false
    and (p_sources is null or c.referral_source = any (p_sources))
    and (coalesce(p_payment_outstanding, false) = false or coalesce(c.account_balance, 0) > 0)
    and (
      case
        when coalesce(p_none, false)
          then ls.lsd is null                          -- never serviced
        else
          (p_date_from is null or (ls.lsd is not null and ls.lsd >= p_date_from))
          and (p_date_to is null or (ls.lsd is not null and ls.lsd <= p_date_to))
      end
    )
  order by ls.lsd desc nulls last, c.id;
$$;
