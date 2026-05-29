-- Store line items (products/services) from SF jobs, synced during the tech SF sync.
-- These are populated regardless of invoice/completion status.

create table if not exists public.sf_job_items (
  id           uuid primary key default gen_random_uuid(),
  sf_job_id    text not null,
  name         text,
  description  text,
  quantity     numeric(10,4),
  unit_price   numeric(12,2),
  sf_synced_at timestamptz not null default now()
);

create index if not exists idx_sf_job_items_job on public.sf_job_items(sf_job_id);

alter table public.sf_job_items enable row level security;

drop policy if exists "admin_all_sf_job_items" on public.sf_job_items;
create policy "admin_all_sf_job_items" on public.sf_job_items
  for all using (public.is_admin());

drop policy if exists "authenticated_read_sf_job_items" on public.sf_job_items;
create policy "authenticated_read_sf_job_items" on public.sf_job_items
  for select using (auth.role() = 'authenticated');

grant select, insert, delete on public.sf_job_items to service_role;
grant select on public.sf_job_items to authenticated;
