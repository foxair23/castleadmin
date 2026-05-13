-- Enable RLS on reference tables that were previously skipped.
-- These tables are read-only reference data; all authenticated users may select,
-- but writes are handled exclusively by the service role (sync scripts).

alter table public.sf_job_statuses_ref   enable row level security;
alter table public.sf_job_categories_ref enable row level security;

create policy "authed_select_sf_job_statuses_ref" on public.sf_job_statuses_ref
  for select using (auth.role() = 'authenticated');

create policy "authed_select_sf_job_categories_ref" on public.sf_job_categories_ref
  for select using (auth.role() = 'authenticated');
