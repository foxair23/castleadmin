-- Marketing "last serviced" — ignore epoch/zero placeholder dates.
--
-- Service Fusion stores 1970-01-01 (Unix epoch) as a placeholder when there is
-- no real date (same zero-date the app already excludes elsewhere via
-- `closed_at > '2000-01-01'`). Those customers were being swept into old date
-- ranges (e.g. ~9.7k of a 13k result had last_service = 1970), which is wrong —
-- they've effectively never been serviced, not "last serviced in 1970".
--
-- Treat any date before 2000-01-01 as NULL (never serviced) for both the stored
-- customer date and the job-derived date. Such customers now fall under the
-- "never serviced" filter instead of polluting a real date range.

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
      and closed_at >= timestamptz '2000-01-01'   -- exclude epoch-zero placeholders
      and customer_id is not null
    group by customer_id
  ),
  eff as (
    select c.id,
           c.referral_source,
           c.account_balance,
           greatest(
             case when c.last_serviced_date >= date '2000-01-01' then c.last_serviced_date end,
             ls.lsd
           ) as last_service
    from public.sf_customers c
    left join last_service ls on ls.customer_id = c.id
    where coalesce(c.is_deleted, false) = false
  )
  select id, last_service
  from eff
  where (p_sources is null or referral_source = any (p_sources))
    and (coalesce(p_payment_outstanding, false) = false or coalesce(account_balance, 0) > 0)
    and (
      case
        when coalesce(p_none, false)
          then last_service is null                    -- never serviced (incl. epoch placeholders)
        else
          last_service is not null
          and (p_date_from is null or last_service >= p_date_from)
          and (p_date_to is null or last_service <= p_date_to)
      end
    )
  order by last_service desc nulls last, id;
$$;
