-- The sf_*_cache compatibility views were flagged by Supabase's security
-- advisor as SECURITY DEFINER. Explicitly mark them as SECURITY INVOKER
-- so they respect the querying user's RLS policies, not the creator's.
alter view public.sf_jobs_cache        set (security_invoker = on);
alter view public.sf_job_techs_cache   set (security_invoker = on);
alter view public.sf_invoices_cache    set (security_invoker = on);
alter view public.sf_estimates_cache   set (security_invoker = on);
alter view public.sf_customers_cache   set (security_invoker = on);
