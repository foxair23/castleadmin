-- ============================================================
-- Migration 018: Phase 1 _cache tables → mirror compatibility views
-- ============================================================
-- Drops the five Phase 1 cache tables and replaces each with a
-- view of the same name backed by the full SF mirror tables from
-- migration 017. Column names / types are aliased to match what
-- the Phase 1 dashboard TypeScript code already expects, so no
-- changes to app/admin/dashboard or lib/analytics are needed.
-- ============================================================

-- Drop old Phase 1 cache objects, whichever kind each one is. A plain
-- `drop view if exists <table>` raises 42809 ("is not a view") because IF EXISTS
-- only suppresses "does not exist", not a type mismatch — so we inspect pg_class
-- and issue the matching DROP for each object (table 'r' / view 'v' / matview 'm').
do $$
declare
  obj   text;
  kind  "char";
begin
  foreach obj in array array[
    'sf_customers_cache', 'sf_jobs_cache', 'sf_job_techs_cache',
    'sf_estimates_cache', 'sf_invoices_cache'
  ]
  loop
    select c.relkind into kind
    from   pg_class c
    join   pg_namespace n on n.oid = c.relnamespace
    where  n.nspname = 'public' and c.relname = obj;

    if    kind = 'v' then execute format('drop view             if exists public.%I cascade', obj);
    elsif kind = 'm' then execute format('drop materialized view if exists public.%I cascade', obj);
    elsif kind is not null then execute format('drop table        if exists public.%I cascade', obj);
    end if;  -- kind null => object absent, nothing to drop
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────
-- sf_jobs_cache
-- Key aliases:
--   total_amount          ← sf_jobs.total
--   scheduled_at          ← sf_jobs.start_date (cast to timestamptz)
--   completed_at          ← sf_jobs.closed_at
--   original_scheduled_at ← first 'initial' entry in sf_job_schedule_history,
--                           falling back to start_date
--   is_closed             ← sf_job_statuses.category ILIKE '%closed%'
--                           or ILIKE '%cancel%' (covers Closed, Cancelled, etc.)
--   schedule_history_truncated ← always false; full history in sf_job_schedule_history
-- ─────────────────────────────────────────────────────────────
create or replace view public.sf_jobs_cache as
select
  j.id,
  j.customer_id,
  j.status              as status_name,
  j.category            as category_name,
  coalesce(
    s.category ilike '%closed%' or s.category ilike '%cancel%',
    false
  )                     as is_closed,
  j.closed_at           as completed_at,
  coalesce(
    (
      select h.scheduled_at
      from   public.sf_job_schedule_history h
      where  h.sf_job_id   = j.id
        and  h.change_type = 'initial'
      order  by h.observed_at asc
      limit  1
    ),
    j.start_date::timestamptz
  )                     as original_scheduled_at,
  j.start_date::timestamptz as scheduled_at,
  j.total               as total_amount,
  false                 as schedule_history_truncated,
  j.created_at_sf,
  j.updated_at_sf,
  j.sf_synced_at        as synced_at
from  public.sf_jobs j
left join public.sf_job_statuses s on s.name = j.status
where j.is_deleted = false;

-- ─────────────────────────────────────────────────────────────
-- sf_job_techs_cache
-- Key aliases:
--   sf_job_id  ← sf_job_techs.job_id
--   sf_tech_id ← sf_job_techs.tech_id
-- Excludes assignments for soft-deleted jobs.
-- ─────────────────────────────────────────────────────────────
create or replace view public.sf_job_techs_cache as
select
  jt.id,
  jt.job_id         as sf_job_id,
  jt.tech_id        as sf_tech_id,
  jt.sf_synced_at   as synced_at
from  public.sf_job_techs jt
join  public.sf_jobs      j  on j.id = jt.job_id
where j.is_deleted = false;

-- ─────────────────────────────────────────────────────────────
-- sf_invoices_cache
-- Key aliases:
--   issued_at   ← sf_invoices.date (cast to timestamptz)
--   balance_due ← 0 when is_paid, else total
--                 (Phase 1 cache had a running balance_due column;
--                  mirror stores is_paid boolean + total instead)
-- ─────────────────────────────────────────────────────────────
create or replace view public.sf_invoices_cache as
select
  i.id,
  i.job_id,
  i.customer_id,
  i.date::timestamptz                              as issued_at,
  i.total,
  case when i.is_paid
       then 0::numeric
       else coalesce(i.total, 0)
  end                                              as balance_due,
  i.sf_synced_at                                   as synced_at
from  public.sf_invoices i
where i.is_deleted = false;

-- ─────────────────────────────────────────────────────────────
-- sf_estimates_cache
-- Columns used by dashboard: id, total, status, created_at_sf
-- All exist verbatim in sf_estimates.
-- ─────────────────────────────────────────────────────────────
create or replace view public.sf_estimates_cache as
select
  e.id,
  e.customer_id,
  e.status,
  e.created_at_sf,
  e.total,
  e.sf_synced_at  as synced_at
from  public.sf_estimates e
where e.is_deleted = false;

-- ─────────────────────────────────────────────────────────────
-- sf_customers_cache
-- Key aliases:
--   lead_source ← sf_customers.referral_source
--   zip         ← primary sf_customer_locations.postal_code
-- ─────────────────────────────────────────────────────────────
create or replace view public.sf_customers_cache as
select
  c.id,
  c.created_at_sf,
  c.referral_source  as lead_source,
  (
    select l.postal_code
    from   public.sf_customer_locations l
    where  l.customer_id = c.id
      and  l.is_primary  = true
    limit  1
  )                  as zip,
  c.sf_synced_at     as synced_at
from  public.sf_customers c
where c.is_deleted = false;

-- ─────────────────────────────────────────────────────────────
-- Grants — mirror migration 010 which granted on the old tables
-- ─────────────────────────────────────────────────────────────
grant select on public.sf_jobs_cache      to authenticated, service_role;
grant select on public.sf_job_techs_cache to authenticated, service_role;
grant select on public.sf_invoices_cache  to authenticated, service_role;
grant select on public.sf_estimates_cache to authenticated, service_role;
grant select on public.sf_customers_cache to authenticated, service_role;
