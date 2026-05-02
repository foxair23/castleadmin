-- ============================================================
-- Castle Garage Doors & Gates — Piecework Payroll App Schema
-- ============================================================

-- Profiles table extends auth.users
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text not null,
  role text not null check (role in ('technician', 'admin')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Job types / pay rate catalog
create table if not exists public.job_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_rate numeric(10,2) not null,
  additional_rate numeric(10,2),
  requires_quantity boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Jobs (one per job site visit)
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  tech_id uuid not null references public.profiles(id),
  work_date date not null,
  job_name text not null,
  notes text,
  total_pay numeric(10,2) not null default 0,
  week_start_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Work items within a job
create table if not exists public.job_work_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  job_type_id uuid not null references public.job_types(id),
  quantity int not null default 1 check (quantity >= 1),
  calculated_pay numeric(10,2) not null
);

-- Week submissions (one per tech per week)
create table if not exists public.week_submissions (
  id uuid primary key default gen_random_uuid(),
  tech_id uuid not null references public.profiles(id),
  week_start_date date not null,
  submitted_at timestamptz not null default now(),
  unique (tech_id, week_start_date)
);

-- ============================================================
-- Row-Level Security
-- ============================================================

alter table public.profiles enable row level security;
alter table public.job_types enable row level security;
alter table public.jobs enable row level security;
alter table public.job_work_items enable row level security;
alter table public.week_submissions enable row level security;

-- Helper: is the current user an admin?
create or replace function public.is_admin()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active = true
  );
$$;

-- profiles: admins see all; techs see themselves
create policy "admin_all_profiles" on public.profiles
  for all using (public.is_admin());

create policy "tech_own_profile" on public.profiles
  for select using (id = auth.uid());

-- job_types: everyone can read active types; only admins write
create policy "anyone_read_job_types" on public.job_types
  for select using (true);

create policy "admin_write_job_types" on public.job_types
  for all using (public.is_admin());

-- jobs: admins see all; techs see/write their own (and only when not submitted)
create policy "admin_all_jobs" on public.jobs
  for all using (public.is_admin());

create policy "tech_own_jobs_select" on public.jobs
  for select using (tech_id = auth.uid());

create policy "tech_own_jobs_insert" on public.jobs
  for insert with check (
    tech_id = auth.uid()
    and not exists (
      select 1 from public.week_submissions ws
      where ws.tech_id = auth.uid()
        and ws.week_start_date = jobs.week_start_date
    )
  );

create policy "tech_own_jobs_update" on public.jobs
  for update using (
    tech_id = auth.uid()
    and not exists (
      select 1 from public.week_submissions ws
      where ws.tech_id = auth.uid()
        and ws.week_start_date = jobs.week_start_date
    )
  );

create policy "tech_own_jobs_delete" on public.jobs
  for delete using (
    tech_id = auth.uid()
    and not exists (
      select 1 from public.week_submissions ws
      where ws.tech_id = auth.uid()
        and ws.week_start_date = jobs.week_start_date
    )
  );

-- job_work_items: follow parent job's policies
create policy "admin_all_work_items" on public.job_work_items
  for all using (public.is_admin());

create policy "tech_own_work_items_select" on public.job_work_items
  for select using (
    exists (select 1 from public.jobs j where j.id = job_id and j.tech_id = auth.uid())
  );

create policy "tech_own_work_items_insert" on public.job_work_items
  for insert with check (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.tech_id = auth.uid()
        and not exists (
          select 1 from public.week_submissions ws
          where ws.tech_id = auth.uid() and ws.week_start_date = j.week_start_date
        )
    )
  );

create policy "tech_own_work_items_delete" on public.job_work_items
  for delete using (
    exists (
      select 1 from public.jobs j
      where j.id = job_id and j.tech_id = auth.uid()
        and not exists (
          select 1 from public.week_submissions ws
          where ws.tech_id = auth.uid() and ws.week_start_date = j.week_start_date
        )
    )
  );

-- week_submissions: admins see all; techs see/insert their own
create policy "admin_all_submissions" on public.week_submissions
  for all using (public.is_admin());

create policy "tech_own_submissions_select" on public.week_submissions
  for select using (tech_id = auth.uid());

create policy "tech_own_submissions_insert" on public.week_submissions
  for insert with check (tech_id = auth.uid());

-- ============================================================
-- Auto-update updated_at on jobs
-- ============================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger jobs_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- ============================================================
-- Seed: initial job types
-- ============================================================
insert into public.job_types (name, base_rate, additional_rate, requires_quantity, is_active) values
  ('Install double-car garage door', 125.00, null, false, true),
  ('Install single-car garage door', 100.00, null, false, true),
  ('Help stacking a door (up to 1 hour)', 30.00, null, false, true),
  ('Help install a custom garage door', 125.00, null, false, true),
  ('Service call (spun cables, door reset, etc.)', 25.00, null, false, true),
  ('Torsion spring change / torsion conversion', 50.00, null, false, true),
  ('Deliveries', 20.00, 10.00, true, true),
  ('One-piece haul away', 100.00, null, false, true),
  ('Private door', 200.00, null, false, true)
on conflict do nothing;
