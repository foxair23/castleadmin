-- Marketing "last serviced" — use the LATER of two sources.
--
-- 047 keyed only on sf_jobs.closed_at, but the jobs mirror may not contain a
-- customer's OLDER jobs, so customers genuinely last serviced long ago had no
-- job row and were wrongly excluded (query returned nothing for old ranges).
--
-- sf_customers.last_serviced_date reflects SF's FULL history but goes stale for
-- recent work; max(sf_jobs.closed_at) is accurate for recent work but misses
-- un-mirrored old jobs. The customer's TRUE last service is the LATER of the two.
-- GREATEST() ignores NULLs, returning the later non-null date (or NULL if both).
--
-- This both fixes the original bug (a recent job pulls the date forward, so
-- recently-serviced customers drop out of old ranges) and restores coverage of
-- customers whose only record is SF's stored date — no jobs backfill required.

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
  select c.id, greatest(c.last_serviced_date, ls.lsd) as last_service
  from public.sf_customers c
  left join last_service ls on ls.customer_id = c.id
  where coalesce(c.is_deleted, false) = false
    and (p_sources is null or c.referral_source = any (p_sources))
    and (coalesce(p_payment_outstanding, false) = false or coalesce(c.account_balance, 0) > 0)
    and (
      case
        when coalesce(p_none, false)
          then greatest(c.last_serviced_date, ls.lsd) is null       -- never serviced by either source
        else
          greatest(c.last_serviced_date, ls.lsd) is not null
          and (p_date_from is null or greatest(c.last_serviced_date, ls.lsd) >= p_date_from)
          and (p_date_to is null or greatest(c.last_serviced_date, ls.lsd) <= p_date_to)
      end
    )
  order by greatest(c.last_serviced_date, ls.lsd) desc nulls last, c.id;
$$;
