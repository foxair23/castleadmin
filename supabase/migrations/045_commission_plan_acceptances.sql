-- Commission plan acceptances — technicians accept their plan's terms before the
-- commission figures are shown (legally-binding, dispute-proof record).
--
-- Model:
--   • Every commission_plan carries variable terms (target + two rates) plus a
--     legal-document version. A fingerprint over (terms + legal version) decides
--     whether a plan is "accepted": a plan is accepted iff an acceptance row
--     exists whose terms_fingerprint equals the plan's current fingerprint.
--   • Editing the plan's numbers (or bumping the legal version) changes the
--     fingerprint, so the prior acceptance no longer matches and the tech must
--     re-accept. The acceptance table is append-only — old rows are preserved.

-- Dedupe column: the last fingerprint we emailed the tech a "please accept"
-- prompt for, so repeated tiny edits don't re-spam.
alter table public.commission_plans
  add column if not exists acceptance_prompt_fingerprint text;

create table if not exists public.commission_plan_acceptances (
  id                uuid primary key default gen_random_uuid(),
  -- Kept for linkage; SET NULL (not CASCADE) so the record survives even if the
  -- plan is later deleted — the snapshot below is the source of truth.
  plan_id           uuid references public.commission_plans(id) on delete set null,
  tech_user_id      uuid not null references public.profiles(id) on delete cascade,
  period_start      date not null,
  period_end        date not null,
  accepted_by       uuid not null references public.profiles(id),
  accepted_name     text not null,          -- typed full-name signature
  accepted_at       timestamptz not null default now(),
  ip                text,
  user_agent        text,
  legal_version     text not null,
  terms_fingerprint text not null,          -- hash(terms + legal_version)
  terms_snapshot    jsonb not null,         -- exact terms + legal version accepted
  created_at        timestamptz not null default now()
);
create index if not exists idx_comm_accept_tech   on public.commission_plan_acceptances(tech_user_id);
create index if not exists idx_comm_accept_period  on public.commission_plan_acceptances(period_start, period_end);
create index if not exists idx_comm_accept_plan    on public.commission_plan_acceptances(plan_id);
create index if not exists idx_comm_accept_fp      on public.commission_plan_acceptances(terms_fingerprint);

alter table public.commission_plan_acceptances enable row level security;

-- Admin: full access (the acceptance log / disputes). Tech: read own only.
-- Inserts are performed by the service-role accept API after authorizing the tech.
drop policy if exists "admin_all_commission_plan_acceptances" on public.commission_plan_acceptances;
create policy "admin_all_commission_plan_acceptances" on public.commission_plan_acceptances
  for all using (public.is_admin());

drop policy if exists "tech_own_commission_plan_acceptances" on public.commission_plan_acceptances;
create policy "tech_own_commission_plan_acceptances" on public.commission_plan_acceptances
  for select using (tech_user_id = auth.uid());
