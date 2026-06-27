-- Commission Module — data model (TRD §5.2)
--
-- Five tables drive commission. All figures are DERIVED from
-- commission_job_eligibility + commission_plans + commission_adjustments +
-- collection state in the mirror; commission_calc_snapshots is only a cache.
--
-- Decisions baked in (confirmed with owner):
--   • Recognition date = sf_jobs.closed_at (work-performed/completion date)
--   • "Collected" = a linked sf_invoices row with is_paid = true
--   • Revenue tracked live until collected, then frozen (revenue_frozen flag)
--   • Periods: calendar month in America/Los_Angeles, first period from
--     2026-06-22; period engine is generic (monthly now, quarterly-capable)
--   • Technician = profiles row (role='technician'), keyed by auth user id

-- ── commission_agent_map — SF agent → Castle technician (§3.2) ──────────────
-- Maps one or more SF agent identities to a technician. Match priority:
-- agent_id when present, else first_name + last_name. The SF "agent" is a
-- distinct concept from profiles.sf_technician_id, so this mapping is required.
create table if not exists public.commission_agent_map (
  id               uuid primary key default gen_random_uuid(),
  tech_user_id     uuid not null references public.profiles(id) on delete cascade,
  agent_id         text,
  agent_first_name text,
  agent_last_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Either an agent_id or a name pair must be present to be matchable.
  check (agent_id is not null or (agent_first_name is not null and agent_last_name is not null))
);

-- A given agent identity maps to exactly one tech. Partial unique indexes so
-- the id-based and name-based mappings don't collide on NULLs.
create unique index if not exists uq_commission_agent_map_id
  on public.commission_agent_map(agent_id) where agent_id is not null;
create unique index if not exists uq_commission_agent_map_name
  on public.commission_agent_map(lower(agent_first_name), lower(agent_last_name))
  where agent_id is null;
create index if not exists idx_commission_agent_map_tech
  on public.commission_agent_map(tech_user_id);

-- ── commission_plans — per tech, per period (§6) ────────────────────────────
create table if not exists public.commission_plans (
  id            uuid primary key default gen_random_uuid(),
  tech_user_id  uuid not null references public.profiles(id) on delete cascade,
  period_type   text not null default 'monthly' check (period_type in ('monthly','quarterly')),
  period_start  date not null,
  period_end    date not null,
  sales_target  numeric(12,2) not null default 0,
  rate_below    numeric(6,4)  not null default 0,  -- e.g. 0.1000 = 10%
  rate_above    numeric(6,4)  not null default 0,  -- e.g. 0.1500 = 15%
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tech_user_id, period_start, period_end)
);
create index if not exists idx_commission_plans_tech   on public.commission_plans(tech_user_id);
create index if not exists idx_commission_plans_period on public.commission_plans(period_start, period_end);

-- ── commission_job_eligibility — per-job eligibility & review state (§3, §4) ─
-- One row per commission-candidate job (a job with a recognition date on/after
-- the start date that carries at least one agent). Drives all commission math
-- and the review queue.
create table if not exists public.commission_job_eligibility (
  id               uuid primary key default gen_random_uuid(),
  sf_job_id        text not null references public.sf_jobs(id) on delete cascade,
  tech_user_id     uuid references public.profiles(id) on delete set null,  -- null until resolved
  recognition_date date not null,                                            -- sf_jobs.closed_at::date
  revenue          numeric(12,2) not null default 0,                         -- live until collected, then frozen
  revenue_frozen   boolean not null default false,                          -- set true once collected
  status           text not null default 'eligible'
                     check (status in ('eligible','not_accepted','needs_review')),
  review_reason    text check (review_reason in ('multiple_agents','unmapped_agent')),
  resolved_by      uuid references auth.users(id),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (sf_job_id)
);
create index if not exists idx_comm_elig_tech   on public.commission_job_eligibility(tech_user_id);
create index if not exists idx_comm_elig_recog  on public.commission_job_eligibility(recognition_date);
create index if not exists idx_comm_elig_status on public.commission_job_eligibility(status);

-- ── commission_adjustments — manual admin +/- (§4.7) ────────────────────────
create table if not exists public.commission_adjustments (
  id            uuid primary key default gen_random_uuid(),
  tech_user_id  uuid not null references public.profiles(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  amount        numeric(12,2) not null,  -- signed
  note          text not null,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists idx_comm_adj_tech   on public.commission_adjustments(tech_user_id);
create index if not exists idx_comm_adj_period on public.commission_adjustments(period_start, period_end);

-- ── commission_calc_snapshots — cached rollup (§5.2, optional cache) ─────────
create table if not exists public.commission_calc_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  tech_user_id        uuid not null references public.profiles(id) on delete cascade,
  period_start        date not null,
  period_end          date not null,
  eligible_revenue    numeric(12,2) not null default 0,
  commission_earned   numeric(12,2) not null default 0,
  commission_payable  numeric(12,2) not null default 0,
  commission_pending  numeric(12,2) not null default 0,
  computed_at         timestamptz not null default now(),
  unique (tech_user_id, period_start, period_end)
);
create index if not exists idx_comm_snap_period on public.commission_calc_snapshots(period_start, period_end);

-- ── Row-Level Security ──────────────────────────────────────────────────────
alter table public.commission_agent_map        enable row level security;
alter table public.commission_plans            enable row level security;
alter table public.commission_job_eligibility  enable row level security;
alter table public.commission_adjustments      enable row level security;
alter table public.commission_calc_snapshots   enable row level security;

-- Agent map: admin-only (configuration). Techs never see the mapping.
drop policy if exists "admin_all_commission_agent_map" on public.commission_agent_map;
create policy "admin_all_commission_agent_map" on public.commission_agent_map
  for all using (public.is_admin());

-- Plans: admin-only. Techs must NOT see rates/targets (§2).
drop policy if exists "admin_all_commission_plans" on public.commission_plans;
create policy "admin_all_commission_plans" on public.commission_plans
  for all using (public.is_admin());

-- Eligibility: admin-all; techs read only their own resolved/eligible rows.
drop policy if exists "admin_all_commission_job_eligibility" on public.commission_job_eligibility;
create policy "admin_all_commission_job_eligibility" on public.commission_job_eligibility
  for all using (public.is_admin());

drop policy if exists "tech_own_commission_job_eligibility" on public.commission_job_eligibility;
create policy "tech_own_commission_job_eligibility" on public.commission_job_eligibility
  for select using (tech_user_id = auth.uid());

-- Adjustments: admin-all; techs read only their own.
drop policy if exists "admin_all_commission_adjustments" on public.commission_adjustments;
create policy "admin_all_commission_adjustments" on public.commission_adjustments
  for all using (public.is_admin());

drop policy if exists "tech_own_commission_adjustments" on public.commission_adjustments;
create policy "tech_own_commission_adjustments" on public.commission_adjustments
  for select using (tech_user_id = auth.uid());

-- Snapshots: admin-all; techs read only their own.
drop policy if exists "admin_all_commission_calc_snapshots" on public.commission_calc_snapshots;
create policy "admin_all_commission_calc_snapshots" on public.commission_calc_snapshots
  for all using (public.is_admin());

drop policy if exists "tech_own_commission_calc_snapshots" on public.commission_calc_snapshots;
create policy "tech_own_commission_calc_snapshots" on public.commission_calc_snapshots
  for select using (tech_user_id = auth.uid());
