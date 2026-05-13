-- Explicit grants required by Supabase Data API change (enforced Oct 30, 2026).
-- All tables need grants to anon/authenticated/service_role so PostgREST can
-- reach them. RLS policies still control row-level access.
--
-- Pattern:
--   anon        — no direct access (app requires login)
--   authenticated — read/write where RLS permits
--   service_role  — full access (admin API routes + sync scripts bypass RLS)

-- ── Core app tables ───────────────────────────────────────────────────────

grant select, insert, update, delete
  on public.profiles to authenticated;
grant all on public.profiles to service_role;

grant select
  on public.job_types to authenticated;
grant all on public.job_types to service_role;

grant select, insert, update, delete
  on public.jobs to authenticated;
grant all on public.jobs to service_role;

grant select, insert, update, delete
  on public.job_work_items to authenticated;
grant all on public.job_work_items to service_role;

grant select, insert, update, delete
  on public.week_submissions to authenticated;
grant all on public.week_submissions to service_role;

-- ── Service Fusion integration tables (004) ───────────────────────────────

grant select, insert, update, delete
  on public.crm_sync_log to authenticated;
grant all on public.crm_sync_log to service_role;

grant select, insert, update, delete
  on public.crm_tokens to authenticated;
grant all on public.crm_tokens to service_role;

-- ── Analytics / cache tables (007) ───────────────────────────────────────

grant select
  on public.sf_job_statuses_ref to authenticated;
grant all on public.sf_job_statuses_ref to service_role;

grant select
  on public.sf_job_categories_ref to authenticated;
grant all on public.sf_job_categories_ref to service_role;

grant select, insert, update, delete
  on public.sf_customers_cache to authenticated;
grant all on public.sf_customers_cache to service_role;

grant select, insert, update, delete
  on public.sf_jobs_cache to authenticated;
grant all on public.sf_jobs_cache to service_role;

grant select, insert, update, delete
  on public.sf_job_techs_cache to authenticated;
grant all on public.sf_job_techs_cache to service_role;

grant select, insert, update, delete
  on public.sf_job_schedule_history to authenticated;
grant all on public.sf_job_schedule_history to service_role;

grant select, insert, update, delete
  on public.sf_job_status_history to authenticated;
grant all on public.sf_job_status_history to service_role;

grant select, insert, update, delete
  on public.sf_estimates_cache to authenticated;
grant all on public.sf_estimates_cache to service_role;

grant select, insert, update, delete
  on public.sf_invoices_cache to authenticated;
grant all on public.sf_invoices_cache to service_role;

grant select, insert, update, delete
  on public.dashboard_annotations to authenticated;
grant all on public.dashboard_annotations to service_role;

grant select, insert, update, delete
  on public.analytics_sync_log to authenticated;
grant all on public.analytics_sync_log to service_role;
