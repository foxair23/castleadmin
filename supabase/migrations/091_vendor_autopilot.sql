-- Per-vendor autopilot for SF job creation. When ON, a cron auto-creates the SF
-- job for NEW orders (first seen at/after enabled_at) — never the backlog.
create table if not exists public.vendor_autopilot (
  vendor      text primary key,
  enabled     boolean not null default false,
  enabled_at  timestamptz,                 -- when autopilot was last turned on (the "new-only" cutoff)
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

insert into public.vendor_autopilot (vendor, enabled) values ('genie_thd', false)
  on conflict (vendor) do nothing;

alter table public.vendor_autopilot enable row level security;
drop policy if exists "admin_all_vendor_autopilot" on public.vendor_autopilot;
create policy "admin_all_vendor_autopilot" on public.vendor_autopilot for all using (public.is_admin());
